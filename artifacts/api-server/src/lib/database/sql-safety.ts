const deniedWords = new Set([
  "ALTER",
  "ANALYZE",
  "ATTACH",
  "BEGIN",
  "CALL",
  "CLUSTER",
  "COMMIT",
  "COPY",
  "CREATE",
  "DECLARE",
  "DELETE",
  "DETACH",
  "DO",
  "DROP",
  "EXEC",
  "EXECUTE",
  "GRANT",
  "INSERT",
  "INTO",
  "LOCK",
  "MERGE",
  "PRAGMA",
  "REPLACE",
  "RESET",
  "REVOKE",
  "ROLLBACK",
  "SAVEPOINT",
  "SET",
  "TRUNCATE",
  "UPDATE",
  "VACUUM",
]);

const deniedFunctions = new Set([
  "BENCHMARK",
  "LOAD_FILE",
  "OPENQUERY",
  "OPENROWSET",
  "OPENDATASOURCE",
  "PG_READ_BINARY_FILE",
  "PG_READ_FILE",
  "PG_SLEEP",
  "SLEEP",
  "XP_CMDSHELL",
]);

/**
 * Replaces comments and quoted literals with spaces while retaining source
 * positions. This is intentionally a conservative guard, not a full SQL parser;
 * the database account must also be read-only.
 */
function maskCommentsAndLiterals(sql: string): string {
  const output = [...sql];
  let i = 0;
  let quote: "'" | '"' | "`" | "]" | undefined;

  const blank = (index: number): void => {
    if (output[index] !== "\n" && output[index] !== "\r") output[index] = " ";
  };

  while (i < sql.length) {
    const char = sql[i]!;
    const next = sql[i + 1];

    if (quote) {
      blank(i);
      if (char === quote || (quote === "]" && char === "]")) {
        if (next === quote) {
          blank(i + 1);
          i += 2;
          continue;
        }
        quote = undefined;
      } else if (char === "\\" && quote === "'" && next !== undefined) {
        blank(i + 1);
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }

    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      blank(i);
      i += 1;
      continue;
    }
    if (char === "[") {
      quote = "]";
      blank(i);
      i += 1;
      continue;
    }

    if (char === "-" && next === "-") {
      while (i < sql.length && sql[i] !== "\n" && sql[i] !== "\r") {
        blank(i);
        i += 1;
      }
      continue;
    }
    if (char === "#" || (char === "/" && next === "*")) {
      const blockComment = char === "/";
      blank(i);
      if (blockComment) {
        blank(i + 1);
        i += 2;
      } else {
        i += 1;
      }
      while (i < sql.length) {
        if (blockComment && sql[i] === "*" && sql[i + 1] === "/") {
          blank(i);
          blank(i + 1);
          i += 2;
          break;
        }
        if (!blockComment && (sql[i] === "\n" || sql[i] === "\r")) break;
        blank(i);
        i += 1;
      }
      continue;
    }

    // PostgreSQL dollar-quoted text is masked as one literal. A positional
    // parameter such as $1 is left untouched.
    if (char === "$") {
      const delimiter = sql.slice(i).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/)?.[0];
      if (delimiter) {
        const end = sql.indexOf(delimiter, i + delimiter.length);
        if (end >= 0) {
          for (let j = i; j < end + delimiter.length; j += 1) blank(j);
          i = end + delimiter.length;
          continue;
        }
      }
    }

    i += 1;
  }

  return output.join("");
}

export function assertReadOnlyQuery(sql: string): string {
  const source = sql.trim();
  if (!source) throw new Error("Provide a SQL query.");
  if (source.length > 50_000) throw new Error("SQL query exceeds the 50,000 character limit.");

  const masked = maskCommentsAndLiterals(source);
  const semicolons = [...masked.matchAll(/;/g)];
  if (
    semicolons.length > 1 ||
    (semicolons.length === 1 && masked.slice(semicolons[0]!.index! + 1).trim() !== "")
  ) {
    throw new Error("Only one SQL statement may be run at a time.");
  }

  const statement = source.replace(/;\s*$/, "");
  const inspected = maskCommentsAndLiterals(statement);
  const words = [...inspected.matchAll(/[A-Za-z_][A-Za-z0-9_$]*/g)].map((match) =>
    match[0].toUpperCase(),
  );
  const firstWord = words[0];

  if (firstWord !== "SELECT" && firstWord !== "WITH") {
    throw new Error("Only SELECT queries and read-only CTEs are allowed.");
  }

  const denied = words.find((word) => deniedWords.has(word));
  if (denied) throw new Error(`Read-only query rejected because it contains ${denied}.`);

  const functionCall = new RegExp(
    `\\b(?:${[...deniedFunctions].join("|")})\\s*\\(`,
    "i",
  );
  if (functionCall.test(inspected)) {
    throw new Error("This query uses a function that is not allowed.");
  }

  if (/\bFOR\s+(?:NO\s+KEY\s+)?UPDATE\b|\bFOR\s+SHARE\b/i.test(inspected)) {
    throw new Error("Locking reads are not allowed.");
  }

  return statement;
}

export function capSqlServerRows(sql: string, limit: number): string {
  const inspected = maskCommentsAndLiterals(sql);
  const words = [...inspected.matchAll(/[A-Za-z_][A-Za-z0-9_$]*/g)];
  let depth = 0;
  let select: RegExpMatchArray | undefined;
  for (const word of words) {
    if (word.index === undefined) continue;
    while (
      depth > 0 &&
      inspected.slice(0, word.index).match(/\(/g)!.length >
        inspected.slice(0, word.index).match(/\)/g)!.length
    ) {
      break;
    }
    if (inspected.slice(word.index, word.index + word[0].length).toUpperCase() === "SELECT") {
      select = word;
      break;
    }
  }

  if (!select || select.index === undefined) return sql;
  let insertion = select.index + select[0].length;
  const remainder = inspected.slice(insertion);
  const modifier = remainder.match(/^(\s+(?:DISTINCT|ALL)\b)/i);
  if (modifier) insertion += modifier[0].length;

  if (/^\s+TOP\b/i.test(inspected.slice(insertion))) return sql;
  return `${sql.slice(0, insertion)} TOP (${limit + 1})${sql.slice(insertion)}`;
}

export function capSubqueryRows(sql: string, limit: number): string {
  const clean = sql.replace(/;\s*$/, "");
  return `SELECT * FROM (${clean}) AS dbpilot_limited LIMIT ${limit + 1}`;
}

export function replaceQuestionMarks(sql: string): string {
  const output = [...sql];
  let index = 1;
  let quote: "'" | '"' | "`" | "]" | undefined;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < sql.length; i += 1) {
    const char = sql[i]!;
    const next = sql[i + 1];

    if (inLineComment) {
      if (char === "\n" || char === "\r") inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (quote) {
      if (char === quote || (quote === "]" && char === "]")) {
        if (next === quote) i += 1;
        else quote = undefined;
      } else if (char === "\\" && quote === "'" && next !== undefined) {
        i += 1;
      }
      continue;
    }
    if (char === "-" && next === "-") {
      inLineComment = true;
      i += 1;
    } else if (char === "/" && next === "*") {
      inBlockComment = true;
      i += 1;
    } else if (char === "#") {
      inLineComment = true;
    } else if (char === "'" || char === '"' || char === "`") {
      quote = char;
    } else if (char === "[") {
      quote = "]";
    } else if (char === "?") {
      const replacement = `@p${index}`;
      output.splice(i, 1, ...replacement);
      i += replacement.length - 1;
      index += 1;
    }
  }

  return output.join("");
}