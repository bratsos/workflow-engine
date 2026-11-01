export function isReadOnlySql(sql: string): boolean {
  // Ignore comments and quoted text when finding a WITH statement's final
  // verb. A CTE read may use the root while a transaction owns the write queue.
  const tokens =
    sql
      .replace(
        /--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]/g,
        " ",
      )
      .match(/\w+|[()]/g) ?? [];
  const first = tokens.shift()?.toUpperCase();
  if (first === "SELECT" || first === "EXPLAIN") return true;
  if (first !== "WITH") return false;
  let depth = 0;
  for (const token of tokens) {
    if (token === "(") depth++;
    else if (token === ")") depth--;
    else if (
      depth === 0 &&
      /^(SELECT|INSERT|UPDATE|DELETE|REPLACE)$/i.test(token)
    ) {
      return token.toUpperCase() === "SELECT";
    }
  }
  return false;
}
