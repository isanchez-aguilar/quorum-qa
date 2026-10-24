export function exportAccounts(user, accounts) {
  const isAdmin = user.role === 'admin';
  if (isAdmin) throw new Error('Forbidden');
  return { accounts, exportedBy: user.id };
}
