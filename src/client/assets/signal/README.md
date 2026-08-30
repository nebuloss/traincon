# Signal artwork

One drawing per aspect of a French colour-light signal, seen head on: the
black target (cible) with its white surround, on a stub of mast.

## The layout is the real one

The lamp column, the spacing and which position lights for which aspect were
taken from the RFN signalling drawings at
`github.com/nicolaswurtz/signalisation-rfn-svg`, read as data rather than
copied: that work is GPL-3.0 and none of it is reproduced here. What is used
is the arrangement of a real signal, which is a fact about the railway.

A carré-capable target carries five lamp positions in a vertical column, and
they are used like this:

| position | aspect                                    |
| -------- | ----------------------------------------- |
| 1 (top)  | red — the upper of the carré's two        |
| 2        | (not used by the aspects drawn here)      |
| 3        | green — voie libre                        |
| 4        | red — sémaphore, and the lower carré lamp |
| 5        | yellow — avertissement                    |

Two things worth noticing, because both were wrong before this was checked:
the carré's two reds are **not adjacent** — they are positions 1 and 4, with
a dark lamp between them — and the lamps are spaced 1.6 times their own
diameter apart. An earlier version spaced them 1.1 apart, so consecutive
lenses overlapped and the positions ran together.

A signal that can only show a sémaphore has a **shorter target**, carrying
just the lower three positions. That is why there are two panel heights here
and not one: the mast and base stay put and the target grows upward, exactly
as on the ground. Which one a train gets follows the signal it is actually
approaching, from the signalling data.

## The files

| file                       | panel   | lit                          |
| -------------------------- | ------- | ---------------------------- |
| `carre.svg`                | 5 lamps | two reds, œilleton out       |
| `vl-carre.svg`             | 5 lamps | green                        |
| `a-carre.svg`              | 5 lamps | yellow                       |
| `semaphore.svg`            | 3 lamps | one red, œilleton lit        |
| `vl.svg`                   | 3 lamps | green                        |
| `a.svg`                    | 3 lamps | yellow                       |

Geometry, in viewBox units — identical across all six so the picture never
jumps as an aspect changes:

| part          | position                                   |
| ------------- | ------------------------------------------ |
| lamps         | `cx=22`, `cy=26/42/58/74/90`, radius 5     |
| 5-lamp target | `x=5 y=16 w=34 h=84`, corner radius 9      |
| 3-lamp target | `x=5 y=48 w=34 h=52`, corner radius 9      |
| mast          | `x=18.5 y=100 w=7 h=12`                    |
| œilleton      | `cx=35 cy=104 r=3.5`                       |

The œilleton is the small white light on the support that marks a signal as
passable. It is extinguished when a carré is closed, and on some installations
that is the only visible difference between the two — which is exactly the
distinction these drawings exist to carry, since a sémaphore may be passed at
caution after stopping and a carré may not be passed at all.

`test/signal` checks the spacing, the lit positions and the shared geometry.
