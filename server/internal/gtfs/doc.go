// Package gtfs loads the SNCF static schedule: the tables that turn a feed's
// opaque identifiers into station names, coordinates and service markers.
//
// Split between the archive itself and the calendar that says which services
// run today, so neither file is named after the package and the package
// comment lives here.
package gtfs
