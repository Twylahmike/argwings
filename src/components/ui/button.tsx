import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { Loader2 } from 'lucide-react'
import { cn } from '~/lib/utils'

const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-2',
  {
    variants: {
      variant: {
        default: 'bg-brand text-brand-foreground hover:opacity-90',
        outline: 'border bg-card hover:bg-muted',
        secondary: 'bg-muted text-foreground hover:opacity-80',
        ghost: 'hover:bg-muted',
        danger: 'bg-danger text-white hover:opacity-90',
        link: 'text-brand underline-offset-4 hover:underline h-auto p-0',
      },
      size: {
        default: 'h-11 px-4', // 44px minimum tap target
        sm: 'h-10 px-3',
        lg: 'h-12 px-6 text-base',
        icon: 'h-11 w-11',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
)

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean
  loading?: boolean
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild, loading, children, disabled, ...props }, ref) => {
    const Comp = asChild ? Slot : 'button'
    return (
      <Comp ref={ref} className={cn(buttonVariants({ variant, size }), className)} disabled={disabled || loading} {...props}>
        {asChild ? children : (<>{loading && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}{children}</>)}
      </Comp>
    )
  },
)
Button.displayName = 'Button'

export { buttonVariants }
