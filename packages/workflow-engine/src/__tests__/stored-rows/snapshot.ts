import { readFileSync } from "node:fs";

export const MODEL_ORDER = [
  "WorkflowRun",
  "WorkflowDefinition",
  "WorkflowStage",
  "WorkflowStep",
  "WorkflowLog",
  "WorkflowArtifact",
  "AICall",
  "WorkflowAnnotation",
  "JobQueue",
  "OutboxEvent",
  "IdempotencyKey",
  "WorkflowBlob",
] as const;

export interface ModelShape {
  columns: string[];
  jsonColumns: string[];
}

export interface StoredRowsMetadata {
  release: string;
  database: "postgresql" | "sqlite";
  prismaMajor: number;
  scenario: string;
  inFlightPoint: string;
  expectedFinalOutcome: { status: string; output: unknown };
  skippedScenarios: string[];
  /** Missing only on snapshots captured before capture-time metadata was added. */
  captureTime?: string;
}

export interface StoredRowsSnapshot {
  format: 1;
  metadata: StoredRowsMetadata;
  columns: Record<string, string[]>;
  jsonColumns: Record<string, string[]>;
  tables: Record<string, Record<string, unknown>[]>;
}

export function parseModelShapes(schema: string): Record<string, ModelShape> {
  const enumNames = new Set(
    [...schema.matchAll(/^enum\s+(\w+)\s*\{/gm)].map((match) => match[1]!),
  );
  const scalarTypes = new Set([
    "String",
    "Boolean",
    "Int",
    "BigInt",
    "Float",
    "Decimal",
    "DateTime",
    "Json",
    "Bytes",
    ...enumNames,
  ]);
  const shapes: Record<string, ModelShape> = {};
  const modelPattern = /^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm;

  for (const match of schema.matchAll(modelPattern)) {
    const [, model, body] = match;
    const fields = body!
      .split("\n")
      .map((line) => line.match(/^\s*(\w+)\s+([A-Za-z]\w*)(?:\?)?(?:\s|$)/))
      .filter((field): field is RegExpMatchArray => Boolean(field))
      .filter((field) => scalarTypes.has(field[2]!));
    shapes[model!] = {
      columns: fields.map((field) => field[1]!).sort(),
      jsonColumns: fields
        .filter((field) => field[2] === "Json")
        .map((field) => field[1]!)
        .sort(),
    };
  }

  for (const model of MODEL_ORDER) {
    if (!shapes[model])
      throw new Error(`Prisma schema is missing model ${model}`);
  }
  return shapes;
}

export function encodeValue(value: unknown): unknown {
  if (value instanceof Date)
    return { $storedRows: "Date", value: value.toISOString() };
  if (typeof value === "bigint")
    return { $storedRows: "BigInt", value: value.toString() };
  if (typeof value === "number" && !Number.isFinite(value))
    return { $storedRows: "Number", value: String(value) };
  if (value === undefined) return { $storedRows: "Undefined" };
  if (value instanceof Uint8Array)
    return {
      $storedRows: "Bytes",
      value: Buffer.from(value).toString("base64"),
    };
  if (Array.isArray(value)) return value.map(encodeValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, encodeValue(item)]),
    );
  }
  return value;
}

export function decodeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeValue);
  if (value && typeof value === "object") {
    const tagged = value as Record<string, unknown>;
    if (typeof tagged.$storedRows === "string") {
      switch (tagged.$storedRows) {
        case "Date":
          return new Date(String(tagged.value));
        case "BigInt":
          return BigInt(String(tagged.value));
        case "Number":
          return Number(String(tagged.value));
        case "Undefined":
          return undefined;
        case "Bytes":
          return Uint8Array.from(Buffer.from(String(tagged.value), "base64"));
      }
    }
    return Object.fromEntries(
      Object.entries(tagged).map(([key, item]) => [key, decodeValue(item)]),
    );
  }
  return value;
}

const futureTimestampColumn =
  /(?:deadline|nextPoll|wake|leaseExpires|lockExpires|retry|scheduled|available)At$/i;

/**
 * Old snapshots predate metadata.captureTime. Use their latest lifecycle date
 * column, while excluding deadlines and scheduling dates that point forward.
 */
export function snapshotCaptureTime(snapshot: StoredRowsSnapshot): Date {
  if (snapshot.metadata.captureTime) {
    const capturedAt = new Date(snapshot.metadata.captureTime);
    if (Number.isNaN(capturedAt.getTime())) {
      throw new Error(
        `Invalid stored-row captureTime: ${snapshot.metadata.captureTime}`,
      );
    }
    return capturedAt;
  }

  let latest: Date | undefined;
  for (const rows of Object.values(snapshot.tables)) {
    for (const row of rows) {
      for (const [column, encoded] of Object.entries(row)) {
        if (futureTimestampColumn.test(column)) continue;
        if (!/(?:At|Time|Timestamp)$/.test(column)) continue;
        const decoded = decodeValue(encoded);
        const value =
          decoded instanceof Date
            ? decoded
            : typeof decoded === "string" &&
                /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(decoded)
              ? new Date(decoded)
              : undefined;
        if (
          value &&
          !Number.isNaN(value.getTime()) &&
          (!latest || value.getTime() > latest.getTime())
        ) {
          latest = value;
        }
      }
    }
  }
  if (!latest) {
    throw new Error(
      `Cannot derive capture time for ${snapshot.metadata.release}/${snapshot.metadata.scenario}`,
    );
  }
  return latest;
}

export async function captureRows(
  client: Record<string, any>,
  schema: string,
  metadata: StoredRowsMetadata,
): Promise<StoredRowsSnapshot> {
  const shapes = parseModelShapes(schema);
  const tables: StoredRowsSnapshot["tables"] = {};
  const columns: StoredRowsSnapshot["columns"] = {};
  const jsonColumns: StoredRowsSnapshot["jsonColumns"] = {};
  for (const model of MODEL_ORDER) {
    const delegate = model[0]!.toLowerCase() + model.slice(1);
    const rows = await client[delegate].findMany({});
    tables[model] = rows.map(encodeValue) as Record<string, unknown>[];
    columns[model] = shapes[model]!.columns;
    jsonColumns[model] = shapes[model]!.jsonColumns;
  }
  return { format: 1, metadata, columns, jsonColumns, tables };
}

export async function clearRows(client: Record<string, any>): Promise<void> {
  for (const model of [...MODEL_ORDER].reverse()) {
    const delegate = model[0]!.toLowerCase() + model.slice(1);
    await client[delegate].deleteMany({});
  }
}

/** Inserts a historical snapshot through the current Prisma model delegates. */
export async function loadSnapshot(
  client: Record<string, any>,
  currentSchema: string,
  snapshot: StoredRowsSnapshot,
): Promise<void> {
  await clearRows(client);
  const currentShapes = parseModelShapes(currentSchema);
  for (const model of MODEL_ORDER) {
    const delegate = model[0]!.toLowerCase() + model.slice(1);
    const allowed = new Set(currentShapes[model]!.columns);
    const rows = (snapshot.tables[model] ?? []).map((encoded) => {
      const decoded = decodeValue(encoded) as Record<string, unknown>;
      // The current database derives eligibility from the event and its run.
      if (model === "OutboxEvent") delete decoded.pruneTerminal;
      return Object.fromEntries(
        Object.entries(decoded).filter(([column]) => allowed.has(column)),
      );
    });
    if (rows.length > 0) await client[delegate].createMany({ data: rows });
  }
}

export function readPrismaSchema(path: string): string {
  return readFileSync(path, "utf8");
}

function valueTypes(
  value: unknown,
  path: string,
  output: Record<string, Set<string>>,
) {
  const add = (at: string, type: string) => {
    const set = (output[at] ??= new Set());
    set.add(type);
  };
  if (value === null) {
    add(path, "null");
  } else if (Array.isArray(value)) {
    add(path, "array");
    for (const item of value) valueTypes(item, `${path}[]`, output);
  } else if (typeof value === "object") {
    add(path, "object");
    for (const [key, item] of Object.entries(value)) {
      valueTypes(item, `${path}.${key}`, output);
    }
  } else {
    add(path, typeof value);
  }
}

export function snapshotShape(snapshot: StoredRowsSnapshot) {
  const shape: Record<
    string,
    { columns: string[]; json: Record<string, Record<string, string[]>> }
  > = {};
  for (const model of MODEL_ORDER) {
    const json: Record<string, Record<string, string[]>> = {};
    for (const column of snapshot.jsonColumns[model] ?? []) {
      const paths: Record<string, Set<string>> = {};
      for (const row of snapshot.tables[model] ?? []) {
        if (column in row) valueTypes(row[column], "$", paths);
      }
      json[column] = Object.fromEntries(
        Object.entries(paths)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([path, types]) => [path, [...types].sort()]),
      );
    }
    shape[model] = {
      columns: [...(snapshot.columns[model] ?? [])].sort(),
      json,
    };
  }
  return shape;
}

export function firstShapeDifference(
  expected: ReturnType<typeof snapshotShape>,
  actual: ReturnType<typeof snapshotShape>,
): string | undefined {
  for (const model of MODEL_ORDER) {
    const expectedColumns = new Set(expected[model]!.columns);
    const actualColumns = new Set(actual[model]!.columns);
    const addedColumns = [...actualColumns].filter(
      (column) => !expectedColumns.has(column),
    );
    const removedColumns = [...expectedColumns].filter(
      (column) => !actualColumns.has(column),
    );
    if (addedColumns.length || removedColumns.length) {
      return `${model} columns changed: added [${addedColumns.join(", ")}], removed [${removedColumns.join(", ")}]`;
    }
    const jsonColumns = new Set([
      ...Object.keys(expected[model]!.json),
      ...Object.keys(actual[model]!.json),
    ]);
    const expectedJsonColumns = Object.keys(expected[model]!.json).sort();
    const actualJsonColumns = Object.keys(actual[model]!.json).sort();
    if (
      JSON.stringify(expectedJsonColumns) !== JSON.stringify(actualJsonColumns)
    ) {
      return `${model} JSON columns changed: expected [${expectedJsonColumns.join(", ")}], captured [${actualJsonColumns.join(", ")}]`;
    }
    for (const column of [...jsonColumns].sort()) {
      const left = expected[model]!.json[column] ?? {};
      const right = actual[model]!.json[column] ?? {};
      const paths = new Set([...Object.keys(left), ...Object.keys(right)]);
      for (const path of [...paths].sort()) {
        const leftTypes = left[path] ?? [];
        const rightTypes = right[path] ?? [];
        if (JSON.stringify(leftTypes) !== JSON.stringify(rightTypes)) {
          return `${model}.${column} JSON path ${path} changed: expected [${leftTypes.join(", ")}], captured [${rightTypes.join(", ")}]`;
        }
      }
    }
  }
  return undefined;
}

export function encodeSnapshot(snapshot: StoredRowsSnapshot): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}
