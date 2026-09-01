# Security policy

## Supported code

Security fixes target the current `main` branch and the active application in `apps/eleven`.

The frozen Google implementation remains available for reference. It does not receive active deployment hardening.

## Report a vulnerability

Do not open a public issue for a secret, authentication fault, or provider-billing risk.

Use GitHub private vulnerability reporting for this repository. If that option is unavailable, contact the repository owner through the linked GitHub profile.

Include the affected route, the observed result, and a minimal reproduction. Remove real provider keys and private listener text.

## Exposed credentials

If a credential appears in a commit or log, revoke it before you remove the text. Git history can retain an old value.

Replace the affected deployment secret. Then redeploy all environments that used the credential.
