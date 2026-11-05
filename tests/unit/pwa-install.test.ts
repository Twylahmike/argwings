import { describe, expect, it } from 'vitest'
import { decideInvite, detectPlatform, fillName, sanitizeAppInstall, DEFAULT_APP_INSTALL, type InstallSnapshot } from '../../src/lib/pwa'

const UA = {
  androidChrome: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  androidEdge: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36 EdgA/124.0.0.0',
  androidSamsung: 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/24.0 Chrome/117.0.0.0 Mobile Safari/537.36',
  iphoneSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  iphoneChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/124.0.0.0 Mobile/15E148 Safari/604.1',
  ipadSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  desktopChrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  desktopEdge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0',
  desktopFirefox: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  macSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
}
const snap = (ua: string, over: Partial<InstallSnapshot> = {}, touch = 0): InstallSnapshot => ({ standalone: false, installedFlag: false, installedByBrowser: false, hasPrompt: false, secure: true, platform: detectPlatform(ua, touch), ...over })

describe('platform detection', () => {
  it('recognises the browsers we support', () => {
    expect(detectPlatform(UA.androidChrome)).toMatchObject({ os: 'android', browser: 'chrome', chromium: true, ios: false })
    expect(detectPlatform(UA.androidEdge)).toMatchObject({ os: 'android', browser: 'edge', chromium: true })
    expect(detectPlatform(UA.androidSamsung)).toMatchObject({ browser: 'samsung', chromium: true })
    expect(detectPlatform(UA.desktopChrome)).toMatchObject({ os: 'windows', browser: 'chrome', chromium: true })
    expect(detectPlatform(UA.desktopEdge)).toMatchObject({ os: 'windows', browser: 'edge', chromium: true })
    expect(detectPlatform(UA.desktopFirefox)).toMatchObject({ browser: 'firefox', chromium: false })
  })
  it('treats every iPhone and iPad browser as iOS, including iPadOS that pretends to be a Mac', () => {
    expect(detectPlatform(UA.iphoneSafari)).toMatchObject({ os: 'ios', ios: true, chromium: false })
    expect(detectPlatform(UA.iphoneChrome)).toMatchObject({ os: 'ios', ios: true, chromium: false })
    expect(detectPlatform(UA.ipadSafari, 5)).toMatchObject({ os: 'ios', ios: true })
    expect(detectPlatform(UA.macSafari, 0)).toMatchObject({ os: 'mac', ios: false })
  })
})

describe('who is invited, and how', () => {
  it('invites with the native prompt whenever the browser offers it', () => {
    expect(decideInvite(snap(UA.androidChrome, { hasPrompt: true }))).toBe('native')
    expect(decideInvite(snap(UA.desktopEdge, { hasPrompt: true }))).toBe('native')
  })
  it('a browser offering the prompt overrides a stored "installed" flag (the app was uninstalled)', () => {
    expect(decideInvite(snap(UA.desktopChrome, { hasPrompt: true, installedFlag: true }))).toBe('native')
  })
  it('stops once installed or running as the app', () => {
    expect(decideInvite(snap(UA.androidChrome, { installedFlag: true }))).toBe('none')
    expect(decideInvite(snap(UA.androidChrome, { installedByBrowser: true }))).toBe('none')
    expect(decideInvite(snap(UA.iphoneSafari, { standalone: true }))).toBe('none')
    expect(decideInvite(snap(UA.desktopChrome, { standalone: true, hasPrompt: true }))).toBe('none')
  })
  it('shows the Add to Home Screen steps on iPhone and iPad until the app is opened from the home screen', () => {
    expect(decideInvite(snap(UA.iphoneSafari))).toBe('ios')
    expect(decideInvite(snap(UA.iphoneChrome))).toBe('ios')
    expect(decideInvite(snap(UA.ipadSafari, {}, 5))).toBe('ios')
    expect(decideInvite(snap(UA.iphoneSafari, { standalone: true }))).toBe('none')
  })
  it('gives instructions, not a broken button, where installation is not supported', () => {
    expect(decideInvite(snap(UA.desktopFirefox))).toBe('instructions')
    expect(decideInvite(snap(UA.macSafari))).toBe('instructions')
  })
  it('stays quiet on Chromium that offers no prompt (installed already or not installable) and on insecure pages', () => {
    expect(decideInvite(snap(UA.desktopChrome))).toBe('none')
    expect(decideInvite(snap(UA.androidChrome, { secure: false, hasPrompt: true }))).toBe('none')
  })
})

describe('owner settings', () => {
  it('falls back to the default wording and rejects bad values', () => {
    const s = sanitizeAppInstall({ headline: '  ', buttonText: 'Get the app', image: 'http://insecure.example/x.png', themeColor: 'red', enabled: false })
    expect(s.headline).toBe(DEFAULT_APP_INSTALL.headline); expect(s.buttonText).toBe('Get the app')
    expect(s.image).toBe(''); expect(s.themeColor).toBe(''); expect(s.enabled).toBe(false)
    expect(sanitizeAppInstall(undefined).enabled).toBe(true)
    expect(sanitizeAppInstall({ image: 'https://cdn.example/x.png', themeColor: '#a9761f' })).toMatchObject({ image: 'https://cdn.example/x.png', themeColor: '#a9761f' })
  })
  it('puts the business name in the text', () => { expect(fillName('Take {name} With You', 'RG Wings Stays')).toBe('Take RG Wings Stays With You') })
})
