import forge from 'node-forge'

const DOC_PRIVATE_KEY_PKCS8_BASE64 =
  'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCJ9N8YTm0wEuBye5zSiZKncNIg6WBvTHjg4dYc9BH0zR+LeHd/jVo+InrMiIFgblnf7eYJ/wlPG5cSMMSyQMHj/7o0prc+VZsqi1mjX88InK4qDl6qFBFrg4dRrCAwILLVOP/ppUU3souMmnYnvOSUyuLBnhSno8qTpFSbcFAkPaHRmUmcTtVPWuNNbPaZVlNn81imIIVw8LKzOzCz9CNNcikkvbUlZp/cZ0Fl3s6icqOCjRvamg8KLZJs9D52S20X60ynreEIn8g6lr77byOGCCRwpdMl9Cl89WmbC3A3RKh7GRPtjyx3B5aQqE3sK5sNT8H8/EqcnQe8QoVBs7x1AgMBAAECggEAbE6vB+oqlt97DuY1TKVtWb+dePFAIKEtFYC4FKsZndOcvGaripxzCO0Q85sH16lLLh8bxyVPLag/hqx7AGcO0e1nRwbMPkf/NfuJOFZzuBMqOSJm96ghtQLiLiCwdJh3Ticd41U5bmziWlS6BqCp5JcUR2XQWXyiAh+1vQMEKC56CNPxr7imXITS7BYdY0qiGiOANcoEJhfQXn4BjzEm2FJufdlHW6/IeRYZ874HF3/7aUOyhbnapxYHU9PzicMc9XwerMcXMGvOfTUnCtRVONLn7jiknbpwdZ1d8PoItUZuaXdAyY6wFHZF+KvyrEoOV0eWRYzPgku2oSMD7IckUQKBgQDy+etogil+3F8S/qW1WiG6l2tLx5cwq3Ak9weN1zOo8A43obtXRxW2b4fDeol8y6LmYaIW9kKmK0qHEx5LoUSH7VN3FigNpFSa6muVJUuY+ob4H3Je+h3PaqbwhVFzjDofuIolPiJZW64LaFPZcxxD9vM2tZ6txLeMUmGftPoVSwKBgQCRWeNxbvTs8U5UknrdDZHUwXUmy5Qg2LUzxDXdbZXgolMh0AgDShcEFvaF+G3OFHj9vovytt0HtEXyC9LEc6w/a08mtGHiAJbjyjrJCHRNrcFflEm1xseIqXQXDj5Tw05XkAnlWN+r0w3Ix45+GrNhMOGfDkVyQeYI5Jsxxt0dPwKBgFJwcWr4HtQoOSnctKSffCovDfycL7QXtukT18BMb/611F0TxtiKCdfoZ4vvm454GUFJhxF7ZIm0zoid9/15LiNgZp1VKynVw878Epx8FvZEql6tbMTE4DBr41BgK46k2WPB3T1do5HmBVthfnGdGM4Gj+bUII6c3BoEKZNieCeZAoGAQ3rx5wXWW/KjpQvkUqAsJhQyqXI2MRGq/n+Hamen/4QdCEOmlLBfAx0OEqCFifljOpquKl7POvZsyrTGg0IYo9DUDGoOT3hqlRKcPBzasf2LGy6jEetZU48oQFPyh7zSsEBE999M6F6xtZdABjerM+IXvVpIz4TcoSBRFMj4es0CgYEAiNCbs2YPKBFpJq9EYsSsx0GwXAItXFAM71TogWs/8InGNq0PYRZTn9Lq6mFEyLkFql1zWQkS7CG3uDPBV+V2G4MbvoZeFgiQmly7uMQJwbEiKjJBsOzkYY2ZhFYLjGUpGer2U82XeEU6F/Vh4FLkVEE2iB3nPpVQs0qPZxfFZvM='

const EXPECTED_SIGNATURE_BASE64 =
  'F1kKldW4u0xdSzMqehHLtrX6ntK6gjlZ1Nu1IwcCYAvGe+K9/+9VZymbyNjw038ZcxGspnDqcz7+UnqqJ8gBPpMZ4yZb/NdS5TNqruuSooj2jgPk/PlM+uFH97NlMDuUdGVaflujhcaG9irkq48PHQ1+swaELq7mKov7NU155k7bRPWjNzIggxF5Sgh3qcOBpeWVxp/WghRsjfO4O0tRohiOK5pdcAPkj5VlunUgW0/Yv/uC9sV8dodLloUNWG6W0c/pEJnsG48pLLmhag5tzKm7nbHHUrRyLv37+qAuG9S5eZvKUaVbuFwxP2ekSLHRRIQVlBeJbuqfHRQXxzZaJw=='

function toPkcs8Pem(base64Body) {
  const lines = String(base64Body || '')
    .replace(/\s+/g, '')
    .match(/.{1,64}/g) || []
  return `-----BEGIN PRIVATE KEY-----\n${lines.join('\n')}\n-----END PRIVATE KEY-----`
}

function main() {
  const message = '123456789'
  const privatePem = toPkcs8Pem(DOC_PRIVATE_KEY_PKCS8_BASE64)
  const privateKey = forge.pki.privateKeyFromPem(privatePem)

  const md = forge.md.sha256.create()
  md.update(message, 'utf8')
  const signByte = privateKey.sign(md)
  const actualSignatureBase64 = forge.util.encode64(signByte)

  const match = actualSignatureBase64 === EXPECTED_SIGNATURE_BASE64

  console.log('[VERIFY] message=', message)
  console.log('[VERIFY] expected_len=', EXPECTED_SIGNATURE_BASE64.length)
  console.log('[VERIFY] actual_len=', actualSignatureBase64.length)
  console.log('[VERIFY] expected_signature=', EXPECTED_SIGNATURE_BASE64)
  console.log('[VERIFY] actual_signature=', actualSignatureBase64)
  console.log(match ? 'MATCH' : 'MISMATCH')
}

main()
