# Design system copy

The landing page's copy of the Rail402 design system, unchanged except for a one-line header naming the
source in each stylesheet. Change the system first, then copy it here again; the page's own layout lives in
`../landing.css` and uses only these tokens.

| File                         | What                                                     | Licence    |
| ---------------------------- | -------------------------------------------------------- | ---------- |
| `tokens.css`                 | Colours, type, spacing, radii, Paper and Stage themes    | Apache-2.0 |
| `rail402.css`                | The `r4-` components                                     | Apache-2.0 |
| `logos/*.svg`                | The mark, and the logo for Paper and for Stage           | Apache-2.0 |
| `fonts/*.woff2`              | Space Grotesk, Archivo, JetBrains Mono (Latin subsets)   | OFL-1.1    |

The fonts are the same files the Explorer and the Playground serve: the Latin subset of each variable font,
unchanged from the Fontsource 5.3.0 packages. Their licence texts, with each family's copyright line, are
`fonts/OFL-*.txt`. The page serves all of them from its own origin, so its policy allows no other.
