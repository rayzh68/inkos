import { createHash } from "node:crypto";

export type CanonicalJsonPrimitive = null | boolean | number | string;
export type CanonicalJsonValue = CanonicalJsonPrimitive | readonly CanonicalJsonValue[] | { readonly [key: string]: CanonicalJsonValue };

const UTF8 = new TextEncoder();
const WINDOWS_ABSOLUTE = /^[A-Za-z]:\//;

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

export function assertIJsonString(value: unknown, label = "string"): string {
  if (typeof value !== "string" || hasUnpairedSurrogate(value)) {
    throw new Error(`${label} is not an I-JSON string: unpaired surrogate`);
  }
  return value;
}

export function assertNfcString(value: unknown, label = "string"): string {
  const text = assertIJsonString(value, label);
  if (text.normalize("NFC") !== text) throw new Error(`${label} must already be Unicode NFC`);
  return text;
}

export function assertSafeUnsignedInteger(value: unknown, label = "integer"): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || Object.is(value, -0) || value < 0) {
    throw new Error(`${label} must be a safe unsigned I-JSON integer`);
  }
  return value;
}

function assertIJsonNumber(value: number): void {
  if (!Number.isFinite(value) || Object.is(value, -0) || (Number.isInteger(value) && !Number.isSafeInteger(value))) {
    throw new Error("Number is not permitted by the I-JSON contract");
  }
}

function serialize(value: unknown, stack: Set<object>): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "string") {
    assertIJsonString(value);
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    assertIJsonNumber(value);
    return JSON.stringify(value);
  }
  if (typeof value !== "object") throw new Error(`Unsupported canonical JSON value: ${typeof value}`);
  if (stack.has(value)) throw new Error("Canonical JSON cannot contain cycles");
  stack.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) throw new Error("Canonical JSON arrays cannot contain holes");
      }
      return `[${value.map((item) => serialize(item, stack)).join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error("Canonical JSON objects must be plain objects");
    return `{${Object.keys(value)
      .sort()
      .map((key) => {
        assertIJsonString(key, "object member name");
        return `${JSON.stringify(key)}:${serialize((value as Record<string, unknown>)[key], stack)}`;
      })
      .join(",")}}`;
  } finally {
    stack.delete(value);
  }
}

export function canonicalJson(value: unknown): string {
  return serialize(value, new Set());
}

export function canonicalJsonBytes(value: unknown): Uint8Array {
  return UTF8.encode(canonicalJson(value));
}

export function sha256Bytes(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function sha256Utf8(value: string): string {
  assertIJsonString(value);
  return sha256Bytes(UTF8.encode(value));
}

export function canonicalSha256(value: unknown): string {
  return sha256Bytes(canonicalJsonBytes(value));
}

export function compareUnsignedUtf8(left: string, right: string): number {
  const a = UTF8.encode(left);
  const b = UTF8.encode(right);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = a[index]! - b[index]!;
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

export function assertCanonicalRelativePath(value: unknown): string {
  const path = assertIJsonString(value, "path");
  const segments = path.split("/");
  if (!path || path.startsWith("/") || WINDOWS_ABSOLUTE.test(path) || path.includes("\\")
    || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`Invalid canonical relative path: ${JSON.stringify(path)}`);
  }
  return path;
}

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    if (ArrayBuffer.isView(value)) return value;
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

class StrictJsonParser {
  private index = 0;

  constructor(private readonly raw: string) {}

  parse(): unknown {
    this.skipWhitespace();
    const value = this.parseValue();
    this.skipWhitespace();
    if (this.index !== this.raw.length) throw new Error(`Invalid JSON trailing content at offset ${this.index}`);
    return value;
  }

  private skipWhitespace(): void {
    while (this.index < this.raw.length && /[\u0009\u000a\u000d\u0020]/.test(this.raw[this.index]!)) this.index += 1;
  }

  private parseValue(): unknown {
    this.skipWhitespace();
    const char = this.raw[this.index];
    if (char === "{") return this.parseObject();
    if (char === "[") return this.parseArray();
    if (char === '"') return this.parseString();
    if (this.raw.startsWith("true", this.index)) { this.index += 4; return true; }
    if (this.raw.startsWith("false", this.index)) { this.index += 5; return false; }
    if (this.raw.startsWith("null", this.index)) { this.index += 4; return null; }
    return this.parseNumber();
  }

  private parseString(): string {
    const start = this.index;
    this.index += 1;
    let escaped = false;
    while (this.index < this.raw.length) {
      const char = this.raw[this.index]!;
      if (!escaped && char === '"') {
        this.index += 1;
        let parsed: unknown;
        try { parsed = JSON.parse(this.raw.slice(start, this.index)); } catch { throw new Error(`Invalid JSON string at offset ${start}`); }
        return assertIJsonString(parsed, "JSON string");
      }
      if (!escaped && char.charCodeAt(0) < 0x20) throw new Error(`Invalid control character at offset ${this.index}`);
      if (!escaped && char === "\\") escaped = true;
      else escaped = false;
      this.index += 1;
    }
    throw new Error(`Unterminated JSON string at offset ${start}`);
  }

  private parseNumber(): number {
    const remainder = this.raw.slice(this.index);
    const match = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(remainder);
    if (!match) throw new Error(`Invalid JSON value at offset ${this.index}`);
    this.index += match[0].length;
    const value = Number(match[0]);
    assertIJsonNumber(value);
    return value;
  }

  private parseArray(): unknown[] {
    this.index += 1;
    const result: unknown[] = [];
    this.skipWhitespace();
    if (this.raw[this.index] === "]") { this.index += 1; return result; }
    while (true) {
      result.push(this.parseValue());
      this.skipWhitespace();
      const char = this.raw[this.index];
      if (char === "]") { this.index += 1; return result; }
      if (char !== ",") throw new Error(`Expected ',' or ']' at offset ${this.index}`);
      this.index += 1;
    }
  }

  private parseObject(): Record<string, unknown> {
    this.index += 1;
    const result: Record<string, unknown> = {};
    const members = new Set<string>();
    this.skipWhitespace();
    if (this.raw[this.index] === "}") { this.index += 1; return result; }
    while (true) {
      this.skipWhitespace();
      if (this.raw[this.index] !== '"') throw new Error(`Expected object member at offset ${this.index}`);
      const key = this.parseString();
      if (members.has(key)) throw new Error(`Duplicate JSON member name: ${key}`);
      members.add(key);
      this.skipWhitespace();
      if (this.raw[this.index] !== ":") throw new Error(`Expected ':' at offset ${this.index}`);
      this.index += 1;
      Object.defineProperty(result, key, {
        value: this.parseValue(), enumerable: true, configurable: true, writable: true,
      });
      this.skipWhitespace();
      const char = this.raw[this.index];
      if (char === "}") { this.index += 1; return result; }
      if (char !== ",") throw new Error(`Expected ',' or '}' at offset ${this.index}`);
      this.index += 1;
    }
  }
}

export function parseJsonRejectingDuplicates(raw: string): unknown {
  assertIJsonString(raw, "raw JSON");
  return new StrictJsonParser(raw).parse();
}
