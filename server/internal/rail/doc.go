// Package rail routes trains over the French national network.
//
// The graph is built from SNCF Réseau's "formes-des-lignes-du-rfn" export and
// weighted with "vitesse-maximale-nominale-sur-ligne", so a train can be placed
// on the rails rather than on a straight line, with a bearing that follows real
// curves and a speed profile taken from the line's own limits.
//
// The package has no file named after it — the work divides into loading the
// export, building the graph, routing over it, reading a place along a path,
// and thinning what is drawn — so the package comment lives here.
package rail
