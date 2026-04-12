# Base de Conhecimento (RAG) — Proposta Técnica

Objetivo: permitir que cada conta alimente a IA com PDFs, URLs e textos, e que as respostas usem esse conteúdo como referência, sem prompts longos.

## Requisitos (v1)
- Upload de PDFs, DOCX e TXT (até X MB por arquivo, configurável).
- Cadastro de URLs (crawler superficial: pega HTML, limpa boilerplate).
- Segmentação em chunks e geração de embeddings.
- Consulta RAG opcional por sessão/chat, com citações (trechos + fonte).
- Gestão por usuário: listar, pausar/ativar e excluir fontes.
- Limites: número máx. de documentos, tamanho por usuário e recálculo manual.

## Schema MySQL
- `kb_sources`
  - `id`, `user_id`, `type` (`pdf|docx|txt|url`), `name`, `source_url` (p/ URL ou caminho interno), `status` (`pending|ready|error|disabled`), `error`, `tokens`, `chunks`, `created_at`, `updated_at`.
- `kb_chunks`
  - `id`, `source_id` FK, `user_id`, `session_scope` (nullable), `chunk_index`, `content` TEXT, `embedding` LONGBLOB (vector serializado), `created_at`.
  - Índices: `(user_id, source_id)`, `(user_id, session_scope)`.
- `kb_queries` (log)
  - `id`, `user_id`, `session_name`, `chat_id`, `query`, `latency_ms`, `result_count`, `created_at`.

## Ingestão
1) Upload (`POST /api/kb/upload`) salva arquivo em `/kb/{userId}/{uuid}.ext}`, cria `kb_sources` com `status=pending`.
2) Worker/cron `processKbSource(id)`:
   - Extrai texto (pdf-lib / mammoth / simple parser).
   - Normaliza (remove boilerplate, dedup de espaços).
   - Chunking: 300–500 tokens, overlap 50.
   - Gera embeddings (OpenAI `text-embedding-3-small` ou provider configurável) e grava em `kb_chunks`.
   - Atualiza `kb_sources.status=ready`, `tokens/chunks`.
3) URLs: download + limpeza (remover script/style/nav), mesma pipeline.

## Consulta (RAG)
- Endpoint `POST /api/kb/query`:
  - body: `{ query, sessionName?, chatId?, topK=6 }`
  - Busca top-K por similaridade (dot-product) usando `embedding` carregado em memória ou via SQL + função custom (se MySQL não tiver vetores, carregar embeddings em Node e rankear).
  - Retorna trechos: `[{ content, sourceName, sourceId, score }]`.
- Integração ao fluxo de resposta:
  - No `aiHandler`, antes de chamar o LLM, se `user.ia_enabled` e `kb_enabled` para a sessão, faz `kb.query`.
  - Monta prompt com contexto concatenado e citações numeradas.
  - Opcional: fallback para resposta sem RAG se nada relevante (`score` < threshold).

## Controles e UI
- Painel “Base de Conhecimento”: upload/lista/estado, botão “Reprocessar”, “Desativar”, ver contagem de chunks.
- Por sessão/chat: toggle “Usar base de conhecimento” + campo de filtro por tags/fonte (v2).
- Mostrar citações na resposta: “Fonte: Manual.pdf (p.3)”.

## Considerações de performance
- Cache in-memory por usuário: map `{sourceId -> [{embedding: Float32Array, content}]}`.
- Evitar explodir memória: limite de fontes/total chunks por usuário; descarregar LRU.
- Filtrar por `session_scope` se definido (ex.: catálogo apenas da sessão “Loja1”).

## Segurança e privacidade
- Escopo por `user_id`; atendentes herdam permissões do titular.
- Sanitizar uploads, limitar tipos/extensões e tamanho.
- Rate limit em `/api/kb/query` e `/api/kb/upload`.

## Passos sugeridos de implementação (incremental)
1) Schema + endpoints mínimos:
   - `POST /api/kb/upload`
   - `POST /api/kb/url`
   - `GET /api/kb/list`
   - `POST /api/kb/query`
2) Worker de ingestão com chunking + embeddings.
3) Integração no `aiHandler` para usar RAG quando habilitado.
4) Painel web para gestão e visualização de fontes e citações.
5) Otimizações (cache, limites, reprocessamento seletivo).
