# Temporary placeholder photos

Temporary stand-ins owned by another client. Must be deleted before merge or deploy.

These nine room photos exist only so the dev branch looks complete before RG Wings has its own photos.
They are used by `src/lib/placeholder-images.ts` and nowhere else, and only when a property has no photo of its own.

To remove: delete this folder, then empty the `PLACEHOLDER_PHOTOS` list in `src/lib/placeholder-images.ts`.
`npm run check:placeholders` (also run by `npm run deploy`) fails while this folder exists.
