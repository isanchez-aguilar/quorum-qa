export function memoryDatabase(customers) {
  return {
    query(sql, parameters) {
      if (parameters) return customers.filter(row => row.name === parameters[0]);
      if (/\bOR\s+1\s*=\s*1/i.test(sql)) return [...customers];
      const match = /WHERE name = '([^']*)'$/.exec(sql);
      return customers.filter(row => row.name === match?.[1]);
    },
  };
}
