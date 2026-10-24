export async function fetchResult(load, progress) {
  setInterval(() => progress('waiting'), 1000);
  return await load();
}
