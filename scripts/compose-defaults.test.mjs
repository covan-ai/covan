// @vitest-environment node
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A fresh clone runs the clone.
 *
 * `covan-api` and `covan-web` declare both `image:` and `build:`. Without a
 * `pull_policy`, compose defaults to `missing`, which asks the registry first
 * and builds only when the pull fails. The images are public, so the pull never
 * failed: `docker compose up` on a clone of `main` started the last release's
 * binary, while `migrate` — which mounts the checkout — applied the clone's
 * migrations. A new schema under an old app, and a cached tag reused after every
 * `git pull` since.
 *
 * So the default is `build`, a published image is an explicit opt-in
 * (`COVAN_PULL=always`), and an opted-in pull tracks the branch (`edge`) rather
 * than the last release. Text and regex rather than a YAML parser, like
 * `compose-env.test.mjs`: the claim is about two lines per service, and the
 * repository has no YAML parser as a dependency.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");

const compose = read("docker-compose.yml");

/** One service's block: from its key to the next top-level service key. */
function service(name) {
  const start = compose.indexOf(`\n  ${name}:\n`);
  expect(start, `${name} is a service in docker-compose.yml`).toBeGreaterThan(-1);
  const rest = compose.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][a-z0-9-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

describe("the two Covan services in docker-compose.yml", () => {
  it.each(["covan-api", "covan-web"])("%s builds the checkout unless told to pull", (name) => {
    const block = service(name);
    expect(block).toMatch(/^ {4}build:$/m);
    expect(block).toMatch(/^ {4}pull_policy: \$\{COVAN_PULL:-build\}$/m);
  });

  it.each(["covan-api", "covan-web"])("%s does not default to the last release", (name) => {
    const image = service(name).match(/^ {4}image: (.+)$/m)?.[1];
    expect(image).toBe(`ghcr.io/covan-ai/${name}:\${COVAN_VERSION:-edge}`);
  });

  it("never defaults COVAN_VERSION to latest anywhere", () => {
    expect(compose).not.toMatch(/\$\{COVAN_VERSION:-latest\}/);
  });
});

describe("what the docs tell someone with a fresh clone", () => {
  /**
   * `docker compose pull` reports `Skipped` for a service whose policy is
   * `build`, so a quickstart that still says to run it describes a step that
   * does nothing. These are the sentences that were false, named so they do not
   * come back.
   */
  it.each(["README.md", "docs/self-hosting.md"])("%s no longer says the old default", (path) => {
    const text = read(path);
    expect(text).not.toMatch(/^docker compose pull\b/m);
    expect(text).not.toContain("omit to build from this checkout");
    expect(text).not.toContain("builds from source when the image is not present");
    expect(text).not.toContain("`docker compose pull` is worth the extra line");
    expect(text).not.toContain("COVAN_VERSION=latest");
  });

  it("documents the opt-in to published images", () => {
    expect(read("README.md")).toContain("COVAN_PULL=always");
    expect(read("docs/self-hosting.md")).toContain("COVAN_PULL=always");
  });

  it(".env.docker.example tracks the branch and builds by default", () => {
    const example = read(".env.docker.example");
    expect(example).toMatch(/^COVAN_VERSION=edge$/m);
    expect(example).toMatch(/^COVAN_PULL=build$/m);
  });
});
