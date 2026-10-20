/**
 * Поток пула решателя (см. pool.ts). Спит в Atomics.wait до нового шага,
 * забирает описание поиска из своего порта (receiveMessageOnPort — без
 * цикла событий), берёт номера раундов из общего счётчика и пишет счёт в
 * кольцо, пока главный не опустит флаг шага.
 */
import { setPriority } from 'node:os';
import { receiveMessageOnPort, workerData, type MessagePort } from 'node:worker_threads';

import { State } from '../engine/state.js';
import { C_BUSY, C_EPOCH, C_JOB, C_PLAYED, C_QUIT, C_RUN, RoundRing, type JobDef } from './pool.js';
import { Rounds } from './solve.js';

const { ctl, port, priority } = workerData as { ctl: Int32Array; port: MessagePort; priority: number };
try {
  // Как у процесса подсказок: игра важнее.
  setPriority(priority);
} catch {
  // без прав — как есть
}

interface Job {
  ring: RoundRing;
  rounds: Rounds;
}

/** Последние поиски (главный присылает описание при каждой смене поиска). */
const jobs = new Map<number, Job>();
const KEEP = 4;

function take(d: JobDef): void {
  const root = new State();
  root.m.set(d.root);
  jobs.delete(d.id);
  jobs.set(d.id, { ring: new RoundRing(d.k, d.sab), rounds: new Rounds(root, d.codes, d.seed, d.knownEvents, d.params, d.weights) });
  if (jobs.size > KEEP) jobs.delete(jobs.keys().next().value!);
}

function run(epoch: number): void {
  const live = () => Atomics.load(ctl, C_RUN) === 1 && Atomics.load(ctl, C_EPOCH) === epoch;
  if (!live()) return;
  const job = jobs.get(Atomics.load(ctl, C_JOB));
  if (!job) return;
  const { ring, rounds } = job;
  while (live()) {
    const r = ring.claim();
    if (r >= ring.maxRounds()) return;
    if (!ring.waitRoom(r, live)) return;
    rounds.play(r, ring.active, ring.slot(r));
    ring.publish(r);
    Atomics.add(ctl, C_PLAYED, 1);
  }
}

let seen = Atomics.load(ctl, C_EPOCH);
for (;;) {
  Atomics.wait(ctl, C_EPOCH, seen);
  seen = Atomics.load(ctl, C_EPOCH);
  if (Atomics.load(ctl, C_QUIT)) break;
  for (let m = receiveMessageOnPort(port); m; m = receiveMessageOnPort(port)) take(m.message as JobDef);
  // Сначала «занят», потом проверка флага: главный, опустив флаг, видит
  // либо этот поток занятым, либо поток уже видит флаг опущенным.
  Atomics.add(ctl, C_BUSY, 1);
  try {
    run(seen);
  } finally {
    Atomics.sub(ctl, C_BUSY, 1);
    Atomics.notify(ctl, C_BUSY);
  }
}
port.close();
