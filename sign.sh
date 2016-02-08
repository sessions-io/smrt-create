#!/bin/bash
cat partials/apple.json | openssl smime -sign -inkey ssl.key -signer ssl.pem -noattr -nodetach -outform DER > partials/apple.json.ciphered