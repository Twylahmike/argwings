import { useBrand, waLink } from '~/lib/brand'
import { normalizePhone } from '~/lib/phone'

/**
 * WhatsApp link builder driven by the configured support number (Admin > Settings, or SUPPORT_WHATSAPP).
 * Returns null when no valid number is configured, so callers hide the button instead of linking anywhere.
 */
export function useWhatsApp(): (text?: string) => string | null {
  const { supportWhatsapp } = useBrand()
  const n = supportWhatsapp ? normalizePhone(supportWhatsapp) : null
  const phone = n && n.ok ? n.phone : null
  return (text?: string) => (phone ? waLink(phone, text) : null)
}
