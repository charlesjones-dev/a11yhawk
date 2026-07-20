# Security Policy

## Supported versions

a11yhawk is pre-1.0 and released from a single active line. Security fixes land on the **latest `0.x` release**; older versions are not backported. Upgrade to the latest version to receive fixes.

| Version      | Supported |
| ------------ | --------- |
| Latest `0.x` | Yes       |
| Older `0.x`  | No        |

## Reporting a vulnerability

Please report security vulnerabilities **privately** through a GitHub security advisory:

**https://github.com/charlesjones-dev/a11yhawk/security/advisories/new**

Do not open a public issue for a suspected vulnerability.

a11yhawk is maintained by a single author on a best-effort basis. You can expect an acknowledgement as soon as is practical and a good-faith effort to assess and address confirmed issues. Please allow reasonable time for a fix before any public disclosure.

## Scope

Some behavior is intentional and documented, not a vulnerability:

- **The SSRF request guard and the `allowPrivateNetworks` opt-out** are documented behavior. The guard is default-on and refuses private / loopback / link-local targets; `allowPrivateNetworks: true` (and the `--allow-private` CLI flag) deliberately widens which resolved addresses the guard accepts, so operators can scan their own internal apps. It does not disable the rest of the guard. This is by design.
- **The Lighthouse egress limitation** is a known, documented residual risk: Lighthouse drives its own browser navigation outside the Playwright request guard, so network-layer egress filtering is the only complete mitigation for multi-tenant deployments. See the [Security section of the README](https://github.com/charlesjones-dev/a11yhawk#security) for the full explanation.

Reports that a11yhawk reaches a private address when it was explicitly configured with `allowPrivateNetworks` / `--allow-private`, or that Lighthouse can reach a target in the absence of operator-provided egress rules, describe documented behavior rather than new vulnerabilities. Reports that demonstrate a bypass of the guard's **defaults** - reaching a private or blocked target without the opt-out - are in scope and very welcome.
