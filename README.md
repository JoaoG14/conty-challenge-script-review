## Como rodar

Node 22 atualizado.

```bash
npm ci
npm test
npm run typecheck
npm run dev
```

A API sobe em `http://127.0.0.1:3003`
O banco fica em `data/reviews.sqlite`

## Exemplo de Request e Response

Crie um roteiro:

```bash
curl -s -X POST localhost:3003/scripts \
  -H 'content-type: application/json' \
  -d '{"campaign_id":"cmp_01","creator_id":"crt_01","content":"Apresentar o produto."}'
```

Resposta `201` (ID e datas são gerados pelo servidor):

```json
{
  "id": "<id retornado>",
  "campaign_id": "cmp_01",
  "creator_id": "crt_01",
  "created_at": "2026-10-09T18:00:00.000Z",
  "status": "in_review",
  "current_version": 1,
  "versions": [{
    "number": 1,
    "content": "Apresentar o produto.",
    "status": "in_review",
    "submitted_at": "2026-10-09T18:00:00.000Z",
    "reviewed_at": null,
    "change_request": null
  }]
}
```

Copie o ID para `SCRIPT_ID`. Os próximos exemplos usam `jq` só para mostrar os campos principais da resposta. A data distante mantém a demonstração executável.

```bash
SCRIPT_ID="<id retornado>"

curl -s -X POST "localhost:3003/scripts/$SCRIPT_ID/versions/1/change-request" \
  -H 'content-type: application/json' \
  -d '{"reason":"Mostrar o produto em uso.","deadline_date":"2099-12-31"}' \
  | jq '{status, current_version}'
# {"status":"changes_requested","current_version":1}

curl -s -X POST "localhost:3003/scripts/$SCRIPT_ID/versions" \
  -H 'content-type: application/json' \
  -d '{"content":"Apresentar e demonstrar o produto em uso."}' \
  | jq '{status, current_version}'
# {"status":"in_review","current_version":2}

curl -s -X POST "localhost:3003/scripts/$SCRIPT_ID/versions/2/approve" \
  | jq '{status, current_version}'
# {"status":"approved","current_version":2}

curl -s "localhost:3003/scripts/$SCRIPT_ID" | jq
```

## Nota para quem avalia

Com mais tempo, adicionaria autenticação com roles de marca e criador, validação dos IDs de campanha e criador e chaves de idempotência para evitar duplicações ao repetir uma requisição

Defini o escopo e a arquitetura e pedi à IA para implementar a solução e criar os testes. Depois, conferi todo o código


