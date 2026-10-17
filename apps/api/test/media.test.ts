import { describe, expect, it } from 'vitest'
import { ipv6Groups, isBlockedAddress, sniff } from '../src/services/media'

describe('image import guard', () => {
  it('blocks loopback, private, link-local, CGNAT and mapped addresses', () => {
    for (const a of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1']) {
      expect(isBlockedAddress(a), a).toBe(true)
    }
  })
  it('sees through IPv6 spellings that carry an IPv4 address', () => {
    for (const a of [
      '::ffff:7f00:1', // ::ffff:127.0.0.1 as Node's URL parser writes it
      '::FFFF:127.0.0.1',
      '0:0:0:0:0:ffff:a9fe:a9fe', // 169.254.169.254
      '::ffff:0a00:0001',
      '::127.0.0.1', // IPv4-compatible
      '::7f00:1',
      '64:ff9b::a00:1', // NAT64 of 10.0.0.1
      '2002:7f00:1::', // 6to4 of 127.0.0.1
      '2002:c0a8:101::1', // 6to4 of 192.168.1.1
      'fec0::1',
      'fe80::1%eth0',
      'ff02::1',
      'not-an-ip',
    ]) {
      expect(isBlockedAddress(a), a).toBe(true)
    }
    expect(ipv6Groups('::ffff:127.0.0.1')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x7f00, 1])
    expect(ipv6Groups('2001:db8::1')).toEqual([0x2001, 0xdb8, 0, 0, 0, 0, 0, 1])
  })
  it('allows public addresses', () => {
    for (const a of ['8.8.8.8', '172.32.0.1', '100.128.0.1', '2606:4700::1111', '::ffff:808:808', '2002:808:808::1', '64:ff9b::808:808']) expect(isBlockedAddress(a), a).toBe(false)
  })
})

describe('image sniffing', () => {
  it('trusts the bytes, not the declared type', () => {
    expect(sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(sniff(Buffer.from('RIFF0000WEBPVP8 ', 'ascii'))).toBe('image/webp')
    expect(sniff(Buffer.from('<svg/>'))).toBeNull()
  })
})
