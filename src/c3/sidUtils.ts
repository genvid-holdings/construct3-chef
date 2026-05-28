import { readFileSync, existsSync } from "node:fs";

const MIN_SID = 1e14;
const MAX_SID = 1e15;
const MAX_ATTEMPTS = 100;

/**
 * Pure parser: read a sid-registry.txt file and return the set of SIDs it contains.
 * Format: `sid TAB source-file TAB location` per line. Ignores blank lines and `#` comments.
 * Throws if the file does not exist.
 */
export function readRegistryFile(registryPath: string): Set<number> {
    if (!existsSync(registryPath)) {
        throw new Error(
            `SID registry not found at ${registryPath} — run 'construct3-chef generate --only sid-registry' first`,
        );
    }
    const content = readFileSync(registryPath, "utf-8");
    const sids = new Set<number>();
    for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const firstCol = trimmed.split("\t")[0];
        const sid = parseInt(firstCol, 10);
        if (!isNaN(sid)) {
            sids.add(sid);
        }
    }
    return sids;
}

declare const __sidGenBrand: unique symbol;

/**
 * A function that mints a fresh unique SID each time it's called.
 * The closure typically holds a Set of already-used SIDs that grows with each mint,
 * so SIDs from one generator never collide with each other.
 *
 * Nominally branded so that `mintUniqueSid` (which has a different shape, taking a
 * Set as its only argument) cannot be silently passed where a `SidGenerator` is
 * expected — that mistake would compile via structural typing but crash at runtime
 * with "Cannot read properties of undefined (reading 'has')". Construct generators
 * via `freshSidGen()` or `makeSidGen(used)`, both of which apply the brand.
 */
export type SidGenerator = (() => number) & { readonly [__sidGenBrand]: true };

/**
 * Wrap a `() => number` closure as a branded `SidGenerator`. The runtime is the
 * same plain function; the cast is purely a type-system marker.
 */
export function makeSidGen(used: Set<number>): SidGenerator {
    return (() => mintUniqueSid(used)) as SidGenerator;
}

/**
 * Build a generator that mints SIDs from a fresh empty Set. Each call to the
 * returned function adds to the same Set, so SIDs from one generator won't
 * collide with each other.
 *
 * Production code should seed from sid-registry.txt instead:
 *   const used = readRegistryFile(registryPath);
 *   const sidGen = makeSidGen(used);
 *
 * `freshSidGen()` is the test-helper shape — SIDs won't collide within the
 * generator but may overlap with on-disk SIDs. Fine for tests that don't read
 * source files.
 */
export function freshSidGen(): SidGenerator {
    return makeSidGen(new Set<number>());
}

/**
 * Stateless: mint a unique SID against a caller-owned Set of already-used SIDs.
 * Mutates `usedSids` by adding the newly-minted SID before returning, so successive
 * calls against the same Set produce non-colliding values.
 *
 * - Returns a value in [1e14, 1e15) — never 0
 * - Throws after 100 attempts on collision (should never happen in practice)
 *
 * This is the canonical SID minter — wrap it in a closure via `freshSidGen()` for
 * tests or `() => mintUniqueSid(seedSet)` for production code that seeds from
 * `readRegistryFile()`.
 */
export function mintUniqueSid(usedSids: Set<number>): number {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const sid = Math.floor(Math.random() * (MAX_SID - MIN_SID)) + MIN_SID;
        if (!usedSids.has(sid)) {
            usedSids.add(sid);
            return sid;
        }
    }
    throw new Error(
        `mintUniqueSid: failed to find a unique SID after ${MAX_ATTEMPTS} attempts (collision loop)`,
    );
}

/**
 * Recursively collect all numeric `sid` values from any C3 JSON value.
 * Returns an empty Set for null, undefined, or non-object inputs.
 */
export function collectSids(json: unknown): Set<number> {
    const result = new Set<number>();
    collectSidsInto(json, result);
    return result;
}

function collectSidsInto(value: unknown, result: Set<number>): void {
    if (value === null || value === undefined) return;
    if (Array.isArray(value)) {
        for (const item of value) {
            collectSidsInto(item, result);
        }
    } else if (typeof value === "object") {
        for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
            if (key === "sid" && typeof child === "number") {
                result.add(child);
            } else {
                collectSidsInto(child, result);
            }
        }
    }
}
