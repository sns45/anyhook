/** @fileoverview Enforces G1: @anyhook/core has zero runtime-SDK dependencies. @module @anyhook/core */
import { describe, test, expect } from 'bun:test';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const PKG_ROOT = join(import.meta.dir, '..');

describe('@anyhook/core SDK-freedom (G1)', () => {
  test('package.json declares no runtime dependencies', () => {
    const pkg = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'));
    expect(pkg.dependencies ?? {}).toEqual({});
  });

  test('no forbidden runtime-SDK imports in src', () => {
    // @anyhook/signing is a zero-dep sibling and is allowed only as a devDependency (tests),
    // never imported from src — so it is NOT on this allow path here.
    const forbidden =
      /@anyhook\/(cloudflare|aws)|@anyq\/|@aws-sdk|@cloudflare|(^|[^.\w])cloudflare:|durable[- ]?object/i;
    const walk = (d: string): string[] =>
      existsSync(d)
        ? readdirSync(d, { withFileTypes: true }).flatMap((e) =>
            e.isDirectory()
              ? walk(join(d, e.name))
              : e.name.endsWith('.ts')
                ? [join(d, e.name)]
                : [],
          )
        : [];
    const files = walk(join(PKG_ROOT, 'src'));
    expect(files.length).toBeGreaterThan(0); // guard against a vacuous pass
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      // strip line comments so doc mentions of "Durable Object" etc. don't trip the grep
      const code = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
      expect({ file: f, hit: forbidden.test(code) }).toEqual({ file: f, hit: false });
    }
  });
});
