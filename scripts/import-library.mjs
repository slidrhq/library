// Brings the published media library into the bucket of the library's Worker, once (README,
// "Publishing the uploads"): calls POST /api/library/import until it says the bucket has every
// file and the manifest. Each call copies a batch from the site (media.slidr.studio, as Cloudflare
// Pages serves it before it is the bucket's), checked against its SHA-256; nothing is copied to
// this machine. Run it again after a failure: a file already in the bucket is not read again.
//
//   $env:LIBRARY_TOKEN = 'slk_…'        an admin's token, of the `publish` scope (the profile)
//   node scripts/import-library.mjs                                  https://library.slidr.workers.dev
//   node scripts/import-library.mjs --url http://127.0.0.1:5176      the page's dev server
//   node scripts/import-library.mjs --from https://<another site>/
//   node scripts/import-library.mjs --batch 100
//
// --from is the site to copy from: the Worker's MEDIA_LIBRARY_URL (the published library) unless
// named. Once the bucket has the library, media.slidr.studio is put before the bucket itself
// (README, "Serving the library").
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : fallback;
};
const url = option('--url', 'https://library.slidr.workers.dev').replace(/\/+$/, '');
const from = option('--from');
const batch = Number(option('--batch', '60'));
// A token of an admin's, of the publish scope: all the library takes from a program.
const key = process.env.LIBRARY_TOKEN;
if (!key) {
  console.error(
    'LIBRARY_TOKEN is not set: a token of the publish scope, made by an admin in the profile.',
  );
  process.exit(1);
}

let failures = 0;
for (;;) {
  const response = await fetch(`${url}/api/library/import`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ limit: batch, ...(from ? { from } : {}) }),
  });
  const answer = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error(
      `${response.status} ${answer.error ?? ''}: ${answer.message ?? response.statusText}`,
    );
    process.exitCode = 1;
    break;
  }
  for (const failed of answer.failed ?? []) console.warn(`  ${failed.path}: ${failed.message}`);
  console.log(
    `${answer.present} of ${answer.files} files in the bucket (${answer.copied} copied, ${answer.remaining} left)`,
  );
  if (answer.done) {
    console.log(`Done: the bucket has the library published ${answer.published}.`);
    break;
  }
  if (answer.copied === 0) {
    failures += 1;
    if (failures >= 3) {
      console.error('Nothing was copied three times running; see the files above.');
      process.exitCode = 1;
      break;
    }
  } else failures = 0;
}
