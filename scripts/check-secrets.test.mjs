import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `docker/check-secrets.sh` is the gate in front of the whole compose stack:
 * every service descends from `db`, and `db` waits for it. It is POSIX sh, so
 * these run it the way compose does — a fresh environment, nothing inherited.
 *
 * The cases are the ones it got wrong: `ALLOWED_ORIGIN` used to be its only
 * sign of a network, so a localhost origin with `BIND_ADDR=0.0.0.0` published
 * Postgres to the network with the shipped password and passed; and two
 * settings that are fine on a laptop and wrong anywhere else — auto-confirmed
 * sign-ups and Realtime's default key — were never asked about.
 */
const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "../docker/check-secrets.sh");

function check(env) {
  return spawnSync("sh", [SCRIPT], { env: { PATH: process.env.PATH, ...env }, encoding: "utf8" });
}

const NETWORKED = {
  ALLOWED_ORIGIN: "https://covan.example",
  MAILER_AUTOCONFIRM: "false",
  REALTIME_DB_ENC_KEY: "a-key-somebody-generated",
};

describe("check-secrets.sh", () => {
  it("lets a laptop through, defaults and all", () => {
    expect(check({ ALLOWED_ORIGIN: "http://localhost:3000" }).status).toBe(0);
  });

  it("treats ports published beyond loopback as facing a network", () => {
    const result = check({ ALLOWED_ORIGIN: "http://localhost:3000", BIND_ADDR: "0.0.0.0" });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/REALTIME_DB_ENC_KEY/);
  });

  it("still lets loopback through however it is spelled", () => {
    for (const BIND_ADDR of ["127.0.0.1", "127.0.1.1", "::1", "localhost"]) {
      expect(check({ ALLOWED_ORIGIN: "http://localhost:3000", BIND_ADDR }).status, BIND_ADDR).toBe(
        0,
      );
    }
  });

  it("refuses auto-confirmed sign-ups on a stack that faces a network", () => {
    const result = check({ ...NETWORKED, MAILER_AUTOCONFIRM: "true" });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/MAILER_AUTOCONFIRM/);

    // Unset is the compose default, which is on.
    const { MAILER_AUTOCONFIRM: _unset, ...withoutIt } = NETWORKED;
    expect(check(withoutIt).status).toBe(1);
  });

  it("refuses Realtime's default key, which compose supplies when .env does not", () => {
    const { REALTIME_DB_ENC_KEY: _unset, ...withoutIt } = NETWORKED;
    const result = check(withoutIt);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/REALTIME_DB_ENC_KEY/);
  });

  it("lets a networked stack through once all of it is its own", () => {
    expect(check(NETWORKED).status).toBe(0);
  });
});
