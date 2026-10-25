# Jarvis — personagem 2.5D animado

Personagem oficial do Jarvis (assistente executivo, terno azul-marinho, camisa branca, gravata cinza, relógio no pulso esquerdo) reconstruído em camadas a partir da imagem de referência e animado no navegador, sem dependências de runtime.

| Peça | Caminho |
|---|---|
| Referência visual oficial | `reference/jarvis-reference.png` (1024×1536, fundo branco) |
| Referência anterior (busto, arquivada) | `reference/archive/jarvis-reference-v1-busto.png` |
| Sliders de override | incluem `swayX`/`swayRot` (balanço do corpo) e os ângulos de ombro/cotovelo de cada braço |
| Pipeline que gera as camadas | `tools/build_layers.py` |
| Camadas + rig | `assets/*.webp`, `assets/rig.json` (≈115 KB no total) |
| Componente reutilizável | `src/jarvis-character.js` (`<jarvis-character>`) |
| Exemplo de integração | `index.html` |
| Interface de desenvolvimento (teste manual de cada estado) | `dev/index.html` |

## Como rodar

É um projeto estático. Sirva a raiz do repositório por HTTP (módulos ES e `fetch` não funcionam via `file://`):

```bash
python3 -m http.server 8765
# http://localhost:8765/            -> exemplo de integração
# http://localhost:8765/dev/        -> interface de desenvolvimento
```

## Fase 1 — Diagnóstico

O repositório estava vazio (sem commits, sem outra base de código do Jarvis acessível na conta), portanto não havia framework, página ou mecanismo de animação a reaproveitar. Para não impor um framework à interface futura, a solução foi construída como um **Web Component em JavaScript puro (Canvas 2D)**, que pode ser colocado em qualquer página (HTML estático, React, Vue, etc.) com uma tag.

Abordagem técnica escolhida (a mais simples que atende aos requisitos):

1. **Recorte em camadas** da imagem de referência, feito uma única vez por um script Python (OpenCV), com **reconstrução por inpainting das regiões ocultas** que os movimentos revelam.
2. **Rig procedural** no navegador: cada camada tem um pivô; parâmetros (ângulos, deslocamentos, abertura da boca, piscada) seguem alvos por **molas amortecidas**, o que dá transições suaves entre estados.
3. **Controladores por estado** que geram os alvos a cada frame (ruído suave para o idle, gerador de visemas para a fala, linhas do tempo curtas para o aceno de confirmação).

Não se usa vídeo pré-renderizado nem deformação da imagem inteira: os movimentos são articulações reais entre camadas independentes.

## Fase 2 — Camadas do personagem

Geradas por `python3 tools/build_layers.py` (requer `opencv-python-headless`, `numpy`, `Pillow`; `--debug` grava PNGs e sobreposições em `tools/debug/`).

| Camada | Conteúdo | Região oculta reconstruída |
|---|---|---|
| `head` | cabeça, cabelo, orelhas e pescoço | pescoço estendido por baixo do colarinho; testa atrás das sobrancelhas; esclera atrás das íris; interior da boca (dentes + cavidade) atrás da mandíbula |
| `browL`, `browR` | sobrancelhas | — |
| `irisL`, `irisR` | íris/pupila (recortadas pela abertura do olho ao desenhar) | — |
| `lidL`, `lidR` | pálpebra fechada (pele reconstruída sobre o olho) | — |
| `jaw` | lábio inferior + queixo (topo exato na linha dos lábios, base esfumada) | — |
| `torso` | paletó, camisa, gravata, calça e sapatos | tecido reconstruído atrás dos braços (o tronco é opaco sob a faixa interna das mangas, por isso as bordas esfumadas dos braços não deixam o fundo vazar) |
| `armRUpper`, `armRFore` | braço direito do personagem: braço; antebraço + mão | sobreposição circular no cotovelo (sem fresta ao articular) |
| `armLUpper`, `armLFore` | braço esquerdo do personagem: braço; antebraço + mão | idem; pulso e punho reconstruídos atrás do relógio |
| `watch` | relógio, no pulso esquerdo do personagem, acompanha o antebraço | — |
| `shadow` | sombra do chão (estática) | — |

A silhueta sai por limiar do fundo branco (frestas de fundo entre manga e tronco são preservadas como transparência; punhos e colarinho brancos são mantidos como tecido). Todos os recortes têm bordas esfumadas de 1 px e as camadas são exportadas em WebP com alfa, recortadas ao seu retângulo. `rig.json` guarda posição de cada camada, pivôs (pescoço, ombros, cotovelos, sobrancelhas), polígonos das aberturas dos olhos, linha dos lábios e enquadramentos.

## Fase 3 — Estados e animações

| Estado | O que acontece |
|---|---|
| `idle` | respiração (escala sutil do tronco + leve subida da cabeça), piscadas naturais aleatórias (com piscada dupla ocasional), micro-movimentos de cabeça, pequenos desvios do olhar, braços quase parados |
| `thinking` | cabeça inclina e sobe de leve, olhar para cima/lado com sacadas, sobrancelha direita erguida, pálpebras um pouco baixas, antebraço esquerdo flexiona um pouco |
| `talking` | boca abre e fecha por um gerador de visemas (sílabas, pausas entre frases), cabeça acompanha as sílabas, sobrancelhas marcam ênfases, antebraços gesticulam à frente do corpo alternando os lados (como no vídeo de referência); com áudio real use `setMouthLevel()` |
| `approval_request` | cabeça vem à frente e olha para o usuário, sobrancelhas erguidas, olhos abertos, os dois braços abrem com as mãos para fora num gesto de "e então?", com leve balanço de espera |
| `confirmed` | aceno curto de cabeça, pequeno impulso da mão, piscada, e retorno gradual; após 1,5 s volta sozinho ao `idle` |

Em todos os estados (exceto com movimento reduzido) o corpo inteiro balança sutilmente sobre os pés, como no vídeo de referência. As piscadas rodam em qualquer estado. Transições entre estados são suaves (molas; nada "pula").

## Fase 4 — Integração / API

```html
<script type="module" src="./src/jarvis-character.js"></script>
<jarvis-character src="./assets/" state="idle" framing="bust"></jarvis-character>
```

```js
const jarvis = document.querySelector('jarvis-character');

jarvis.setState('thinking');          // idle | thinking | talking | approval_request | confirmed
jarvis.say(3000);                     // talking por 3 s, depois volta ao estado anterior
jarvis.stopTalking();                 // encerra a fala antes do tempo
jarvis.requestApproval();             // approval_request (fica até você mudar o estado)
jarvis.confirm();                     // confirmed -> idle (ou confirm({ returnTo: 'thinking' }))
jarvis.setMouthLevel(0.7);            // lip-sync com nível de áudio 0..1 (null volta ao gerador interno)
jarvis.blink();                       // piscada imediata
jarvis.setFraming('face');            // 'full' | 'bust' | 'face' | [x, y, w, h] em px da imagem
jarvis.addEventListener('jarvis-statechange', (e) => console.log(e.detail.from, '->', e.detail.to));
```

Módulos sem referência ao elemento podem disparar eventos globais (o componente escuta por padrão; `listen="false"` desliga):

```js
window.dispatchEvent(new CustomEvent('jarvis:state', { detail: { state: 'talking', duration: 2500 } }));
window.dispatchEvent(new CustomEvent('jarvis:mouth', { detail: { level: 0.4 } }));
```

Atributos: `src` (pasta dos assets), `state`, `framing`, `background` (`none` = transparente, padrão; `white` ou qualquer cor CSS), `listen`, `reduced-motion` (`auto` | `true` | `false`), `paused`.

Comportamento na interface:

- O canvas tem `pointer-events: none`: nunca bloqueia cliques, botões ou formulários por cima ou em volta.
- Ocupa 100% da largura do contêiner e define a proporção pelo enquadramento (2:3 em `full`, 1:1 em `bust`/`face`); redimensiona com `ResizeObserver` e respeita `devicePixelRatio` (até 2×).
- Carregamento: 15 WebP (≈115 KB) decodificados em paralelo; `jarvis-ready` dispara quando pronto. O loop de desenho pausa com a aba oculta, com `paused="true"` e não desenha fora da viewport.
- `prefers-reduced-motion: reduce` (ou `reduced-motion="true"`): sem balanço contínuo nem respiração; as poses dos estados são aplicadas de forma estática, as piscadas ficam mais espaçadas e a boca na fala tem amplitude reduzida.

`index.html` mostra o fluxo completo acionado por eventos reais da aplicação: enviar mensagem → `thinking` → resposta → `talking` (duração proporcional ao texto) → `idle`; pedido de aprovação → `approval_request` → Aprovar → `confirmed` → `idle`.

## Fase 5 — Validação

Interface de desenvolvimento (`dev/index.html`): botões para cada estado, `say()`, `blink()`, ciclo automático de todos os estados, tamanhos de contêiner (96 px a tela cheia, incluindo recorte circular), enquadramentos, fundo transparente/branco, palco claro/escuro, movimento reduzido forçado, pausa, sliders de override de cada parâmetro do rig (cabeça, sobrancelhas, olhar, piscada, boca, respiração, ombros e cotovelos), liga/desliga por camada, FPS e log de eventos. O botão sobreposto ao personagem comprova que os cliques passam.

Testes feitos no Chromium (Playwright) antes de concluir:

- Todos os estados e transições, incluindo `confirmed` voltando ao `idle` e `say()` voltando ao estado anterior.
- Fluxo da página de integração (thinking → talking → approval_request → confirmed → idle) e eventos globais.
- Recortes e articulações em close (olhos, boca, pescoço/colarinho, cotovelos, punho com relógio) em repouso e com parâmetros no extremo: sem frestas no cotovelo, sem fundo vazando nas costuras das mangas, relógio sempre no pulso esquerdo.
- Contêineres de 96, 200, 320 e 420 px, viewport mobile (390 px) e desktop; 60 fps; sem erros de console.
- `prefers-reduced-motion` emulado: movimento contínuo da cabeça e respiração zerados, estados ainda legíveis.

Limitações conhecidas (não são placeholders, são limites do método com uma única imagem):

- O rosto ocupa ~120 px na referência; no enquadramento `face` muito ampliado a imagem fica suave. Para avatar pequeno use `bust` ou `face` em até ~250 px.
- A boca abre por deslocamento da mandíbula com interior pintado (dentes + cavidade); não há formas de vogais distintas (visemas "O"/"E").
- Os gestos de braço são rotações 2D de ombro e cotovelo; a mão não gira a palma.
- Não há sorriso: a referência tem a boca neutra e um sorriso convincente exigiria uma segunda imagem da boca (ou uma ferramenta de rigging com malha, como Live2D/Spine) para gerar a camada extra.

## Manutenção

- Para ajustar recortes, pivôs ou polígonos (olhos, boca, braços), edite as constantes no topo de `tools/build_layers.py` e rode `python3 tools/build_layers.py --debug`; confira `tools/debug/regions_face.png` e `regions_arms.png`.
- Para ajustar o "jeito" de cada estado, edite `CONTROLLERS` em `src/jarvis-character.js` (deslocamentos em unidades escaladas por `rig.unit`, ângulos em graus) e as molas em `PARAM_DEFS`.
- Para trocar a imagem de referência, substitua `reference/jarvis-reference.png` por outra de 1024×1536 com fundo branco e refaça os polígonos.
