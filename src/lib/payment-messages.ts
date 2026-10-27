/** Friendly text for Daraja result codes (1032 cancelled, 1037 timeout, 1 insufficient funds, 2001 wrong PIN). */
export function mpesaFailureMessage(code: number | null | undefined, desc?: string | null): string {
  switch (code) {
    case 1032: return 'You cancelled the request on your phone. Tap "Try again" when you are ready.'
    case 1037: return 'The request timed out before a PIN was entered. Tap "Try again" and watch your phone.'
    case 1: return 'Your M-Pesa balance is too low for this payment. Top up, then try again.'
    case 2001: return 'The M-Pesa PIN was not correct. Please try again.'
    case 1001: return 'Another M-Pesa request is still active on your phone. Wait a minute, then try again.'
    default: return desc && !/^the service request is processed/i.test(desc) ? `The payment did not go through (${desc}). Please try again.` : 'The payment did not go through. Please try again.'
  }
}

export const STK_WAIT_SECONDS = 120
