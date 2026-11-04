// Fails while temporary third-party placeholder photos are in the tree. Run before any deploy.
import { existsSync } from 'node:fs'
const dir = 'src/assets/placeholders-everlett'
if (existsSync(dir)) {
  console.error(`BLOCKED: ${dir}/ still exists. It holds temporary photos owned by another client.\nDelete the folder and empty PLACEHOLDER_PHOTOS in src/lib/placeholder-images.ts, then retry.`)
  process.exit(1)
}
console.log('Placeholder check passed: no temporary third-party photos.')
