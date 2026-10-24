export function exportAccounts(user, accounts) {
  if (user.role !== 'admin') throw new Error('Forbidden');
  return accounts;
}
