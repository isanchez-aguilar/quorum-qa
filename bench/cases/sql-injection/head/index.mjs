export function findCustomer(db, name) {
  const query = "SELECT * FROM customers WHERE name = '" + name + "'";
  return { customer: db.query(query)[0] ?? null };
}
