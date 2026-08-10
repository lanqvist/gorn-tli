/**
 * Все изменения сумки по конкретным предметам: под каким протоколом,
 * на какой странице, как менялось количество.
 *
 *   npx tsx scripts/check-item.mjs <лог> <id> [<id>...]
 */
import { createReadStream, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const [logPath, ...ids] = process.argv.slice(2);
const watch = new Set(ids);
const items = new Map(
  JSON.parse(readFileSync('data/items.json', 'utf8')).map((i) => [String(i.id), i.name]),
);

const RE_TS = /^\[(\d{4})\.(\d{2})\.(\d{2})-(\d{2})\.(\d{2})\.(\d{2}):(\d{3})\]/;
const RE_PROTO = /ItemChange@ ProtoName=(\w+) (start|end)/;
const RE_MOD =
  /BagMgr@:Modfy BagItem PageId = (\d+) SlotId = (\d+) ConfigBaseId = (\d+) Num = (\d+)/;
const RE_INIT =
  /BagMgr@:InitBagData PageId = (\d+) SlotId = (\d+) ConfigBaseId = (\d+) Num = (\d+)/;
const RE_REMOVE = /BagMgr@:RemoveBagItem PageId = (\d+) SlotId = (\d+)/;
const RE_ENTER = /LevelMgr:_EnterLevelSuccess\(\) (\d+)/;

const rl = createInterface({
  input: createReadStream(logPath, { encoding: 'utf8' }),
  crlfDelay: Infinity,
});

let proto = null;
const slotOwner = new Map(); // page:slot -> id (чтобы понять, что удалили)

for await (const line of rl) {
  const t = RE_TS.exec(line);
  const clock = t ? `${t[4]}:${t[5]}:${t[6]}` : '        ';

  let m;
  if ((m = RE_PROTO.exec(line))) {
    proto = m[2] === 'start' ? m[1] : null;
    continue;
  }
  if ((m = RE_ENTER.exec(line))) {
    console.log(`${clock}  ── вход в зону ${m[1]}`);
    continue;
  }
  if ((m = RE_INIT.exec(line))) {
    slotOwner.set(`${m[1]}:${m[2]}`, m[3]);
    if (watch.has(m[3])) {
      console.log(
        `${clock}  СНИМОК   ${(items.get(m[3]) ?? m[3]).padEnd(30)} page=${m[1]} slot=${m[2]} num=${m[4]}`,
      );
    }
    continue;
  }
  if ((m = RE_MOD.exec(line))) {
    slotOwner.set(`${m[1]}:${m[2]}`, m[3]);
    if (watch.has(m[3])) {
      console.log(
        `${clock}  ИЗМЕНЕНИЕ ${(items.get(m[3]) ?? m[3]).padEnd(30)} page=${m[1]} slot=${m[2]} num=${m[4]}  протокол=${proto ?? '—'}`,
      );
    }
    continue;
  }
  if ((m = RE_REMOVE.exec(line))) {
    const owner = slotOwner.get(`${m[1]}:${m[2]}`);
    if (owner && watch.has(owner)) {
      console.log(
        `${clock}  УДАЛЕНИЕ  ${(items.get(owner) ?? owner).padEnd(30)} page=${m[1]} slot=${m[2]}  протокол=${proto ?? '—'}`,
      );
    }
    slotOwner.delete(`${m[1]}:${m[2]}`);
  }
}
