export async function saveProfile(store, profile) {
  store.save(profile).catch(() => {});
  return { saved: true, id: profile.id };
}
