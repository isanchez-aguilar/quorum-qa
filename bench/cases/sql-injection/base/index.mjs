export function findCustomer(db, name) {
  return db.query('SELECT * FROM customers WHERE name = ?', [name]);
}
