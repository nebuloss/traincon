# Vehicle artwork

Each file is one rail vehicle seen from directly above, drawn nose-right, at
true proportions: the viewBox is the vehicle in decimetres, so a 26.4 m Corail
coach is 264 units long and 29 wide. Keeping that ratio is what makes the
train look right against the platform beside it, and it is why the plan view
only appears once the map is zoomed in far enough for 2.9 m to be a few pixels
across — below that the map falls back to a disc.

`{{band}}` and `{{body}}` are replaced with the livery before the file is
rasterised — see `core/TrainArt.ts`. `band` is the flank, the colour the train
is known by; `body` is the roof, which is what you actually see from up here.
Everything else — glass, pantographs, roof equipment, door leaves — is common
to every livery and painted in place.

The vehicles, and why each one exists:

| file                | vehicle                        | length |
| ------------------- | ------------------------------ | ------ |
| `power-car.svg`     | TGV motrice, one at each end   | 22.1 m |
| `coach-artic.svg`   | TGV remorque, articulated      | 18.7 m |
| `loco.svg`          | electric locomotive, Intercités| 17.5 m |
| `coach.svg`         | Corail coach                   | 26.4 m |
| `emu-cab.svg`       | multiple-unit end car, TER     | 27.0 m |
| `emu-mid.svg`       | multiple-unit centre car, TER  | 27.0 m |

Lengths are the real ones; `TrainArt` reads them from the viewBox rather than
keeping a second copy that could drift.
