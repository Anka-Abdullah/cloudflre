#!/usr/bin/env node
/**
 * Writes a per-number `knowledge/ongkir-policy.json` for SANDBOX use.
 *
 *   pnpm run assign-ongkir -- --number 6281234567890 --ratio 0.5 --seed 20261010
 *   pnpm run assign-ongkir -- --number 6281234567890 --ratio 0.3 --excluded-ratio 0.2
 *   pnpm run assign-ongkir -- --number 6281234567890 \
 *     --knowledge /path/to/knowledge.txt --out /tmp/policy.json
 *
 * Why this exists: the real catalogue has no `Ongkir:` line at all, so with an
 * empty policy every order goes to admin review (the safe default, Q25=A). To
 * exercise branch A ("link otomatis") in a sandbox, some products have to be
 * marked `included` — but randomly, per run, would make tests irreproducible.
 * The selection is therefore seeded: the same `--seed` always yields the same
 * policy, so a sandbox finding can be replayed exactly.
 *
 * It reads knowledge.txt and never writes to it. The only file it creates is the
 * policy (or whatever `--out` points at).
 *
 * The product-key rule is NOT re-implemented here: it comes from
 * shared/src/bot/knowledge/catalog.ts, imported directly through Node's built-in
 * TypeScript support, so the script and the worker can never disagree about what
 * a product's `kode` is.
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assignOngkirPolicy, parseCatalog } from "../shared/src/bot/knowledge/catalog.ts";

const cloudflareRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const E164 = /^[1-9][0-9]{7,14}$/;

const DEFAULTS = {
  ratio: 0.5,
  excludedRatio: 0,
  seed: 20261010,
  defaultDecision: "admin",
  number: null,
  knowledge: null,
  out: null,
  dryRun: false,
};

function parseArgs(argv) {
  const options = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`missing value for ${arg}`);
      return value;
    };
    switch (arg) {
      case "--number":
      case "-n":
        options.number = String(next()).replace(/[^0-9]/g, "");
        break;
      case "--ratio":
        options.ratio = Number(next());
        break;
      case "--excluded-ratio":
        options.excludedRatio = Number(next());
        break;
      case "--seed":
        options.seed = Number(next());
        break;
      case "--default":
        options.defaultDecision = next();
        break;
      case "--knowledge":
        options.knowledge = next();
        break;
      case "--out":
        options.out = next();
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--help":
      case "-h":
        console.log(
          [
            "usage: pnpm run assign-ongkir -- --number <nomor> [options]",
            "",
            "  --ratio <0..1>          bagian produk yang diberi \"included\"   (default 0.5)",
            "  --excluded-ratio <0..1> bagian SISANYA yang diberi \"excluded\"  (default 0)",
            "  --seed <int>            benih acak deterministik               (default 20261010)",
            "  --default <decision>    included|excluded|admin                (default admin)",
            "  --knowledge <path>      knowledge.txt sumber  (default <nomor>/knowledge/knowledge.txt)",
            "  --out <path>            berkas keluaran       (default <nomor>/knowledge/ongkir-policy.json)",
            "  --dry-run               cetak ringkasan tanpa menulis berkas",
            "",
            "Produk yang tidak dipilih TIDAK ditulis ke berkas, sehingga mengikuti",
            "\"default\". Dengan default=admin, itu berarti review admin (aman).",
          ].join("\n"),
        );
        process.exit(0);
        break;
      default:
        if (arg.startsWith("-")) throw new Error(`unknown option ${arg}`);
        if (options.number === null) options.number = String(arg).replace(/[^0-9]/g, "");
        else throw new Error(`unexpected argument ${arg}`);
    }
  }
  return options;
}

function assertRatio(name, value) {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be a number between 0 and 1, received ${JSON.stringify(value)}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.number === null || !E164.test(options.number)) {
    throw new Error("--number is required, for example: --number 6281234567890");
  }
  assertRatio("--ratio", options.ratio);
  assertRatio("--excluded-ratio", options.excludedRatio);
  if (!Number.isInteger(options.seed)) throw new Error(`--seed must be an integer, received ${options.seed}`);
  if (!["included", "excluded", "admin"].includes(options.defaultDecision)) {
    throw new Error(`--default must be included, excluded or admin, received ${JSON.stringify(options.defaultDecision)}`);
  }

  const knowledgePath = resolve(
    options.knowledge ?? join(cloudflareRoot, options.number, "knowledge", "knowledge.txt"),
  );
  const outPath = resolve(
    options.out ?? join(cloudflareRoot, options.number, "knowledge", "ongkir-policy.json"),
  );

  let text;
  try {
    text = await readFile(knowledgePath, "utf8");
  } catch (error) {
    throw new Error(
      `could not read knowledge.txt at ${knowledgePath} (${error.code ?? error.message}).\n` +
        `  Copy the catalogue into <nomor>/knowledge/knowledge.txt first, or point at it:\n` +
        `    pnpm run assign-ongkir -- --number ${options.number} --knowledge /path/to/knowledge.txt`,
    );
  }

  const { products, skipped } = parseCatalog(text);
  if (products.length === 0) {
    throw new Error(`${knowledgePath} contains no "#NN <nama>" product block; wrong file?`);
  }

  // Selection and seeding live in catalog.ts so the rule is unit-tested there.
  const assigned = assignOngkirPolicy(products, {
    ratio: options.ratio,
    excludedRatio: options.excludedRatio,
    seed: options.seed,
    defaultDecision: options.defaultDecision,
  });

  const policy = {
    _comment: [
      `Dibuat oleh scripts/assign-ongkir.mjs (SANDBOX). seed=${options.seed} ratio=${options.ratio} excludedRatio=${options.excludedRatio}.`,
      "Jalankan ulang dengan seed yang sama untuk hasil yang identik.",
      "Untuk PRODUKSI nilai wajib ditetapkan pemilik toko, bukan diacak.",
    ],
    ...assigned,
  };

  const entries = assigned.products;
  const decided = Object.keys(entries).length;
  const includeCount = Object.values(entries).filter((value) => value === "included").length;
  const excludeCount = Object.values(entries).filter((value) => value === "excluded").length;
  console.log(`knowledge : ${knowledgePath}`);
  console.log(`produk    : ${products.length}${skipped.length > 0 ? ` (${skipped.length} dilewati)` : ""}`);
  console.log(`seed      : ${options.seed}  ratio: ${options.ratio}  excluded-ratio: ${options.excludedRatio}`);
  console.log(`default   : ${options.defaultDecision}`);
  console.log(`keputusan : ${includeCount} included, ${excludeCount} excluded, ${products.length - decided} mengikuti default`);

  if (skipped.length > 0) {
    console.log("dilewati (harga tidak terbaca):");
    for (const line of skipped.slice(0, 10)) console.log(`  ${line}`);
  }

  if (options.dryRun) {
    console.log("\n--dry-run: tidak ada berkas yang ditulis");
    return;
  }

  await writeFile(outPath, `${JSON.stringify(policy, null, 2)}\n`, "utf8");
  console.log(`\nditulis   : ${outPath}`);
  console.log("knowledge.txt TIDAK diubah.");
}

main().catch((error) => {
  console.error(`error: ${error.message}`);
  process.exit(1);
});
