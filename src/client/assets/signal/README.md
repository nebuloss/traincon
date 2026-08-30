# Signal artwork

One drawing per aspect of a French colour-light signal, seen head on: the
black target (cible) on its mast, with the lenses in a vertical column.

The geometry is shared by all four so they can be swapped without the picture
jumping. In viewBox units:

| part      | position                                  |
| --------- | ----------------------------------------- |
| target    | `x=3 y=2 w=24 h=44`, corner radius 5      |
| lenses    | `cx=15`, `cy=12 / 24 / 36`, radius 5      |
| mast      | `x=13 y=46 w=4 h=30`                      |
| œilleton  | `cx=23.5 cy=53 r=2.6`                     |

The lens radius and the 12-unit spacing are the point of that table: an
earlier version spaced them 5.5 apart with a radius of 4.4, so consecutive
lamps overlapped by three units and the three positions could not be told
apart. `test/signal` checks they stay clear of each other.

Which lamps are lit, and why:

| file                 | aspect        | lit                        |
| -------------------- | ------------- | -------------------------- |
| `libre.svg`          | voie libre    | green, centre              |
| `avertissement.svg`  | avertissement | yellow, centre             |
| `semaphore.svg`      | sémaphore     | red centre, œilleton lit   |
| `carre.svg`          | carré         | two reds, œilleton out     |

The œilleton is the small white light on the mast that marks a signal as
passable. It is extinguished when a carré is closed, and on some installations
that is the only visible difference between the two — which is exactly the
distinction these drawings exist to carry, since a sémaphore may be passed at
caution after stopping and a carré may not be passed at all.
