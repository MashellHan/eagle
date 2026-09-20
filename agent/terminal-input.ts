import { createConnection } from "node:net";
import { dirname, join, parse } from "node:path";
import type { LiveInput } from "../src/shared/realtime.ts";

// Herdr 0.9.1 protocol 22: bincode standard, prefixed by a u32 LE length.
// Only strict AttachTerminal is used. ControlTerminal can fall back to a pane/name.
const integer = (n: number): Buffer => {
  if (!Number.isSafeInteger(n) || n < 0 || n > 0xffffffff)
    throw new Error("Invalid integer");
  if (n < 251) return Buffer.from([n]);
  const b = Buffer.alloc(n <= 65535 ? 3 : 5);
  b[0] = b.length === 3 ? 251 : 252;
  if (b.length === 3) b.writeUInt16LE(n, 1);
  else b.writeUInt32LE(n, 1);
  return b;
};
const vector = (value: string | Buffer) => {
  const b = Buffer.from(value);
  return Buffer.concat([integer(b.length), b]);
};
const frame = (...parts: Buffer[]) => {
  const b = Buffer.concat(parts);
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32LE(b.length);
  return Buffer.concat([prefix, b]);
};
class Reader {
  private at = 0;
  private data: Buffer;
  constructor(data: Buffer) {
    this.data = data;
  }
  number(): number {
    const tag = this.data.readUInt8(this.at++);
    if (tag < 251) return tag;
    const size = tag === 251 ? 2 : tag === 252 ? 4 : tag === 253 ? 8 : 0;
    if (!size) throw new Error("Invalid varint");
    const n =
      size === 8
        ? Number(this.data.readBigUInt64LE(this.at))
        : this.data.readUIntLE(this.at, size);
    this.at += size;
    if (!Number.isSafeInteger(n)) throw new Error("Integer overflow");
    return n;
  }
  bytes() {
    const length = this.number();
    if (length > this.data.length - this.at) throw new Error("Invalid vector");
    const b = this.data.subarray(this.at, this.at + length);
    this.at += length;
    return b;
  }
  done() {
    if (this.at !== this.data.length) throw new Error("Unexpected payload");
  }
}
const basic = {
  enter: [13, "\r"],
  esc: [27, "\x1b"],
  tab: [9, "\t"],
  "shift+tab": [9, "\x1b[Z"],
  backspace: [127, "\x7f"],
  "ctrl+c": [99, "\x03"],
  "ctrl+d": [100, "\x04"],
  "ctrl+l": [108, "\x0c"],
} as const;
function keyBytes(
  key: LiveInput["keys"][number],
  flags: number,
  modify: number,
) {
  const [code, legacy] = basic[key];
  const modifier = key.startsWith("ctrl+") ? 5 : key === "shift+tab" ? 2 : 1;
  if (modify > 2) throw new Error("Unsupported keyboard mode");
  if (flags && (flags & 8 || modifier !== 1 || key === "esc")) {
    const press = `\x1b[${code};${modifier}${flags & 2 ? ":1" : ""}u`;
    const release =
      flags & 2 && (flags & 8 || key !== "shift+tab")
        ? `\x1b[${code};${modifier}:3u`
        : "";
    return press + release;
  }
  return modify === 2 && key === "shift+tab" ? "\x1b[27;2;9~" : legacy;
}
export async function submitTerminalInput(
  apiPath: string,
  input: LiveInput,
  size: { width: number; height: number },
  signal: AbortSignal,
  validate: () => Promise<boolean>,
): Promise<"submitted" | "rejected" | "unknown"> {
  if (
    signal.aborted ||
    [...input.text].some(
      (c) =>
        (c.charCodeAt(0) < 32 && c !== "\n" && c !== "\t") ||
        c.charCodeAt(0) === 127,
    ) ||
    ![size.width, size.height].every(
      (n) => Number.isInteger(n) && n > 0 && n <= 65535,
    )
  )
    return "rejected";
  return new Promise((resolve) => {
    const socket = createConnection(
      join(dirname(apiPath), `${parse(apiPath).name}-client.sock`),
    );
    let bytes = Buffer.alloc(0),
      received = 0,
      welcomed = false,
      screen = false,
      sent = false,
      checking = false,
      settled = false;
    let keyboard: { flags: number; modify: number } | undefined;
    const finish = (status = sent ? "unknown" : "rejected") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      socket.destroy();
      resolve(status as "submitted" | "rejected" | "unknown");
    };
    const abort = () => finish();
    const timer = setTimeout(abort, 5000);
    signal.addEventListener("abort", abort, { once: true });
    const send = async () => {
      if (!screen || !keyboard || checking || settled) return;
      checking = true;
      try {
        if (!(await validate()) || signal.aborted || settled) {
          finish();
          return;
        }
        const mode = keyboard;
        const keys = input.keys.map((key) =>
          keyBytes(key, mode.flags, mode.modify),
        );
        const messages: Buffer[] = [];
        // Complete paste in its own Input: Herdr applies the runtime's paste mode.
        if (input.text)
          messages.push(
            frame(integer(1), vector(`\x1b[200~${input.text}\x1b[201~`)),
          );
        for (const key of keys) messages.push(frame(integer(1), vector(key)));
        messages.push(frame(integer(4)));
        sent = true;
        socket.write(Buffer.concat(messages));
      } catch {
        finish();
      }
    };
    socket.on("error", abort);
    socket.on("end", abort);
    socket.on("close", abort);
    socket.on("connect", () => {
      if (signal.aborted) {
        finish();
        return;
      }
      socket.write(
        frame(
          integer(0),
          integer(22),
          integer(size.width),
          integer(size.height),
          integer(0),
          integer(0),
          integer(0),
        ),
      );
    });
    socket.on("data", (chunk) => {
      received += chunk.length;
      if (received > 8 * 1024 * 1024) {
        finish();
        return;
      }
      bytes = Buffer.concat([bytes, Buffer.from(chunk)]);
      try {
        while (bytes.length >= 4 && !settled) {
          const length = bytes.readUInt32LE();
          if (length === 0 || length > 2 * 1024 * 1024)
            throw new Error("Invalid frame size");
          if (bytes.length < length + 4) break;
          const reader = new Reader(bytes.subarray(4, length + 4));
          bytes = bytes.subarray(length + 4);
          const type = reader.number();
          if (!welcomed) {
            if (
              type !== 0 ||
              reader.number() !== 22 ||
              reader.number() !== 1 ||
              reader.number() !== 0
            )
              throw new Error("Unsupported handshake");
            reader.done();
            welcomed = true;
            socket.write(
              frame(integer(5), vector(input.terminalId), integer(0)),
            );
          } else if (type === 1) {
            reader.number();
            const columns = reader.number(),
              rows = reader.number();
            if (columns < 1 || rows < 1 || columns > 65535 || rows > 65535)
              throw new Error("Invalid screen size");
            const full = reader.number();
            if (full > 1) throw new Error("Invalid full-frame flag");
            reader.bytes();
            reader.done();
            if (full === 1) screen = true;
            void send();
          } else if (type === 16) {
            const flags = reader.number(),
              modify = reader.number();
            reader.done();
            if (flags > 31) throw new Error("Unsupported keyboard mode");
            keyboard = { flags, modify };
            void send();
          } else if (type === 3) {
            const option = reader.number();
            if (option > 1) throw new Error("Invalid option");
            const reason = option === 1 ? reader.bytes().toString() : "";
            reader.done();
            finish(sent && reason === "detached" ? "submitted" : undefined);
          }
          // Graphics/notifications are discarded locally, never logged or forwarded.
        }
      } catch {
        finish();
      }
    });
  });
}
