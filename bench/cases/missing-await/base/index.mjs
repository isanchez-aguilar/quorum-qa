export async function saveProfile(store, profile) {
  await store.save(profile);
}
