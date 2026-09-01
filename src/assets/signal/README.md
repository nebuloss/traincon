# Signal artwork

One drawing per aspect of a French colour-light signal, seen head on: the
black target (cible) with its white surround, on a stub of mast.

## Where the layout came from

The lamp spacing, the colours and the way a lit lens is drawn were taken from
the RFN signalling drawings at
`github.com/nicolaswurtz/signalisation-rfn-svg`, read as data rather than
copied: that work is GPL-3.0 and none of it is reproduced here. What is used
is how a real signal is arranged, which is a fact about the railway.

The one thing worth keeping from it: the lamps are spaced **1.6 times their
own diameter** apart — 16 between centres for a radius of 5. An earlier
version spaced them 1.1 apart, so consecutive lenses overlapped and the
positions ran together.

## The head is the SNCF three-lamp target

Green on top, red in the middle, yellow at the bottom. That is the SNCF
order, taken from a semaphore-only target in the reference drawings, which
carries the lower three of a full head's five positions — green at 79, red at
95, yellow at 111. It is **not** the road traffic-light stack, and drawing it
as one would be a signal that does not exist.

A carré-capable target carries all five positions and lights the first and
fourth — two reds that are *not* adjacent. That is not drawn here: at the
size this is shown, five lenses leave each of them a few pixels across.

The two stop aspects are told apart by the œilleton rather than by a second
red. That is how they are told apart on the ground in any case, and on some
installations it is the only visible difference.

## The files

| file            | aspect        | lit                        |
| --------------- | ------------- | -------------------------- |
| `vl.svg`        | voie libre    | green                      |
| `a.svg`         | avertissement | yellow                     |
| `semaphore.svg` | sémaphore     | red, œilleton lit          |
| `carre.svg`     | carré         | red, œilleton out          |

Geometry, in viewBox units — identical across all four so the picture never
jumps as an aspect changes:

| part      | position                              |
| --------- | ------------------------------------- |
| lamps     | `cx=22`, `cy=26` green / `42` red / `58` yellow, radius 5 |
| target    | `x=5 y=16 w=34 h=52`, corner radius 9 |
| mast      | `x=18.5 y=68 w=7 h=12`                |
| œilleton  | `cx=35 cy=72 r=3.5`                   |

The œilleton is the small white light on the support that marks a signal as
passable. It is extinguished when a carré is closed, and on some installations
that is the only visible difference between the two — which is exactly the
distinction these drawings exist to carry, since a sémaphore may be passed at
caution after stopping and a carré may not be passed at all.

`test/signal` checks the spacing, which lamp lights for which aspect, and
that the fixed parts are identical across the four.
