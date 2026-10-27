import * as React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { cn } from '~/lib/utils'

export const Dialog = DialogPrimitive.Root
export const DialogTrigger = DialogPrimitive.Trigger
export const DialogClose = DialogPrimitive.Close

function Content({
  className, children, side, title, description, ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & { side?: 'right' | 'center'; title: string; description?: string }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/50" />
      <DialogPrimitive.Content
        className={cn(
          'fixed z-50 bg-card shadow-xl focus:outline-none',
          side === 'right'
            ? 'inset-y-0 right-0 flex w-full max-w-md flex-col overflow-y-auto border-l p-5'
            : 'left-1/2 top-1/2 max-h-[90dvh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border p-5',
          className,
        )}
        {...props}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <DialogPrimitive.Title className="text-lg font-semibold">{title}</DialogPrimitive.Title>
            <DialogPrimitive.Description className={description ? 'mt-1 text-sm text-muted-foreground' : 'sr-only'}>
              {description ?? title}
            </DialogPrimitive.Description>
          </div>
          <DialogPrimitive.Close className="-mr-2 -mt-2 inline-flex h-11 w-11 items-center justify-center rounded-md hover:bg-muted" aria-label="Close">
            <X className="h-5 w-5" />
          </DialogPrimitive.Close>
        </div>
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  )
}
/** Centered modal */
export const DialogContent = (p: React.ComponentProps<typeof Content>) => <Content side="center" {...p} />
/** Side drawer (booking quick actions, mobile menu) */
export const SheetContent = (p: React.ComponentProps<typeof Content>) => <Content side="right" {...p} />
