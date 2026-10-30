/**
 * prisma/contract.prisma (Prisma 8) must describe the same tables as
 * prisma/schema.prisma (Prisma 6 and 7). The files are compared as text, with
 * no database: models, tables, columns (type, nullability, defaults, generated
 * values), enums, index names and columns, and foreign keys. The one thing a
 * contract cannot say is a sort direction, so the schema's `sort: Desc`
 * indexes are held against prisma/mixed-order-indexes.sql instead.
 */

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const read = (name: string) =>
  readFile(new URL(`../../../prisma/${name}`, import.meta.url), "utf8");

const strip = (text: string) => text.replace(/\/\/.*$/gm, "");
const columnsOf = (list: string) =>
  list.split(",").map((c) => c.trim().match(/^\w+/)?.[0] ?? "");
const SCALARS: Record<string, string> = {
  String: "String",
  Int: "Int",
  Float: "Float",
  DateTime: "TimestampString(3)",
  Json: "Jsonb",
};

function summarise(source: string, dialect: "schema" | "contract") {
  const text = strip(source);
  const enums = new Map<string, string[]>();
  const enumBlock =
    dialect === "schema"
      ? /^enum (\w+) \{([^}]*)\}/gm
      : /^native_enum (\w+) \{([^}]*)\}/gm;
  for (const [, name, body] of text.matchAll(enumBlock)) {
    enums.set(
      name,
      body
        .split("\n")
        .map((l) => l.trim().split(/[\s=]/)[0])
        .filter(Boolean),
    );
  }
  const modelNames = [...text.matchAll(/^model (\w+) \{/gm)].map((m) => m[1]);
  const models: Record<string, unknown> = {};

  for (const [, name, body] of text.matchAll(
    /^model (\w+) \{([\s\S]*?)^\}/gm,
  )) {
    const table = body.match(/@@map\("([^"]+)"\)/)?.[1] ?? name;
    const columns: string[] = [];
    const relations: string[] = [];
    const indexes: string[] = [];

    for (const line of body.split("\n")) {
      const attrs = line.trim();
      const block = attrs.match(/^@@(index|unique|id)\(\[([^\]]*)\]/);
      if (block) {
        const [, kind, list] = block;
        const cols = columnsOf(list);
        const unique = kind === "unique" || attrs.includes("unique: true");
        const mapped = attrs.match(/map: "([^"]+)"/)?.[1];
        const fallback = `${table}_${cols.join("_")}_${unique ? "key" : "idx"}`;
        indexes.push(
          kind === "id"
            ? `primary key (${cols})`
            : `${mapped ?? fallback} ${unique ? "unique " : ""}(${cols})`,
        );
        continue;
      }
      const field = attrs.match(
        /^(\w+)\s+([\w.]+(?:\([^)]*\))?)(\[\]|\?)?(.*)$/,
      );
      if (!field || attrs.startsWith("@@")) continue;
      const [, column, rawType, modifier = "", rest] = field;
      const enumName =
        dialect === "schema"
          ? enums.has(rawType)
            ? rawType
            : undefined
          : rawType.match(/^pg\.enum\((\w+)\)$/)?.[1];
      if (modelNames.includes(rawType)) {
        const fk = rest.match(
          /fields: \[(\w+)\], references: \[(\w+)\].*?onDelete: (\w+)/,
        );
        relations.push(
          `${column} -> ${rawType}${modifier}${fk ? ` (${fk[1]} -> ${fk[2]}, ${fk[3]})` : ""}`,
        );
        continue;
      }
      if (rest.includes("@id")) indexes.push(`primary key (${column})`);
      const type = enumName
        ? `pg.enum(${enumName})`
        : dialect === "schema"
          ? SCALARS[rawType]
          : rawType;
      const given = rest.match(/@default\(((?:[^()]|\([^()]*\))*)\)/)?.[1];
      // Generated values: a schema writes `@default(cuid())` / `@updatedAt`, a
      // contract `@onCreate(cuid(2))` / `@onUpdate(now())`.
      const generated = /cuid\(|@onCreate\(cuid/.test(rest)
        ? "cuid"
        : /@updatedAt|@onUpdate/.test(rest)
          ? "updated"
          : "";
      const defaultValue = /^cuid\(/.test(given ?? "")
        ? ""
        : (given ?? "").replace(/^json`|[`"]/g, "");
      columns.push(
        `${column} ${type}${modifier} default=${defaultValue} generated=${generated}`,
      );
    }
    models[name] = {
      table,
      columns: columns.sort(),
      relations: relations.sort(),
      indexes: indexes.sort(),
    };
  }
  return { enums: Object.fromEntries(enums), models };
}

describe("I want the Prisma 8 reference contract to match schema.prisma", () => {
  it("describes the same models, columns, enums, indexes and relations", async () => {
    const [schema, contract] = await Promise.all([
      read("schema.prisma"),
      read("contract.prisma"),
    ]);

    expect(summarise(contract, "contract")).toEqual(
      summarise(schema, "schema"),
    );
  });

  it("holds every sort: Desc index of schema.prisma in the companion SQL", async () => {
    const [schema, sql] = await Promise.all([
      read("schema.prisma"),
      read("mixed-order-indexes.sql"),
    ]);

    const expected: string[] = [];
    for (const [, body] of strip(schema).matchAll(
      /^model \w+ \{([\s\S]*?)^\}/gm,
    )) {
      const table = body.match(/@@map\("([^"]+)"\)/)?.[1];
      for (const [, list] of body.matchAll(/@@index\(\[([^\]]*)\]/g)) {
        if (!list.includes("sort: Desc")) continue;
        const elements = list.split(/,(?![^(]*\))/).map((c) => c.trim());
        const name = `${table}_${columnsOf(list).join("_")}_idx`;
        const columns = elements
          .map(
            (c) =>
              `"${columnsOf(c)[0]}"${c.includes("sort: Desc") ? " DESC" : ""}`,
          )
          .join(", ");
        expected.push(`CREATE INDEX "${name}" ON "${table}" (${columns});`);
      }
    }

    const actual = sql
      .split("\n")
      .filter((line) => line.startsWith("CREATE INDEX"));
    expect(actual.sort()).toEqual(expected.sort());
  });
});
