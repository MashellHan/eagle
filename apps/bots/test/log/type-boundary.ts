// Compile-time boundary for the emit call. `tsc --noEmit` runs over test/**, so an
// unused @ts-expect-error below means someone made raw literals assignable again.
import { declareEvent, Events } from "../../src/log/events.ts";
import { Log } from "../../src/log/log.ts";

const log = new Log(() => {});
const trace = "tr_0190a1b2-3e4f-7a50-8b1c-2d3e4f506172";

log.emit("info", "core", Events.protocolCommandOk, { trace });

// @ts-expect-error a literal is not a declared event
log.emit("info", "core", "protocol.command.ok", { trace });

log.emit("info", "protocol", declareEvent("protocol.command.ok"), { trace });

const alias = "protocol.command.ok";
// @ts-expect-error an aliased string is not a declared event either
log.emit("info", "core", alias, { trace });
