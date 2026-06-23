'use client'

import { Button } from '@/components/ui/button'

type GoogleSignInButtonProps = {
  disabled?: boolean
  onError?: (message: string) => void
  onClick: () => Promise<void>
}

export function GoogleSignInButton({ disabled, onError, onClick }: GoogleSignInButtonProps) {
  const handleClick = async () => {
    try {
      await onClick()
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : 'Google sign-in failed. Please try again.'
      onError?.(message)
    }
  }

  return (
    <Button
      type="button"
      variant="outline"
      disabled={disabled}
      onClick={handleClick}
      className="w-full rounded-lg border-[#E9E9E7] bg-white text-[#37352F] hover:bg-[#FAFAF8]"
    >
      <span className="mr-2 inline-flex h-5 w-5 items-center justify-center rounded-full border border-[#E9E9E7] text-xs font-bold">
        G
      </span>
      Continue with Google
    </Button>
  )
}

export function AuthDivider() {
  return (
    <div className="relative my-6">
      <div className="absolute inset-0 flex items-center">
        <span className="w-full border-t border-[#E9E9E7]" />
      </div>
      <div className="relative flex justify-center text-xs uppercase">
        <span className="bg-white px-3 text-[#9B978E]">or</span>
      </div>
    </div>
  )
}
