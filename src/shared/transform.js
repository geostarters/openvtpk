'use strict'
const bundle = require('@syncpoint/compact-cache-bundle')
const fs = require('fs')
const path = require('path')
const MBTiles = require('@mapbox/mbtiles')
const Pbf = require('pbf')
const Promise = require('bluebird')
const VectorTile = require('@mapbox/vector-tile').VectorTile

const inspect = require('../shared/inspect')
const levels = require('../shared/levels')
const content = require('../shared/content')
const coordinates = require('../shared/coordinates')
const root = require('../shared/root')

const fsOpen = Promise.promisify(fs.open)
const fsClose = Promise.promisify(fs.close)
const gunzip = Promise.promisify(require('zlib').gunzip)


function log(debug, message) {
    if (debug) { 
      console.log(message);
    }
  }

/**
 * 
 * @param {String} filepath the fully qualified path and filename for the MBTiles container
 * @param {String} mode defaults to 'rwc' for read, write, create
 */
const createMBTileContainer = (filepath, mode = 'rwc') => {
    return new Promise((resolve, reject) => {
        new MBTiles(`${filepath}?mode=${mode}`, (error, mbTilesWrapper) => {
            if (error) {
                return reject(error)
            }
            const mbTilesWrapperAsync = Promise.promisifyAll(mbTilesWrapper)
            return resolve(mbTilesWrapperAsync)
        }
        )
    })
}

/**
 * 
 * @param {Buffer} tileBuffer a buffer representing an gzip compressed Mapbox vector tile
 * @returns {Array[String]} the name of the layers that are used by the vector tile
 */
const exploreLayers = async (tileBuffer) => {
    const uncompressedTile = await gunzip(tileBuffer)
    const protoBuffer = new Pbf(uncompressedTile)
    const tile = new VectorTile(protoBuffer)
    const layers = Object.keys(tile.layers)
    return layers
}

/**
 * 
 * @param {Set} setOfLayers a set that contains all the layers
 * @returns {Array} 
 */
const toVectorLayers = (setOfLayers) => {
    const vectorLayers = []

    for (let layer of setOfLayers) {
        vectorLayers.push({
            id: layer,
            fields: {}
        })
    }
    return vectorLayers
}

/**
 * 
 * @param {JSON} rootData the tile root information
 * @param {Object} levels zoom levels that are transformed into the MBTiles container
 * @param {Set[String]} layers the layers used in the vector tiles
 * @returns {Object} contains the metadata required by the MBTiles container
 */
const tilesetInfo = (rootData, levels, layers) => {

    const getBounds = initialExtent => {
        const bounds = []
        // left bottom
        bounds.push(coordinates.webMercator.xyToLatLng([initialExtent.xmin, initialExtent.ymin]))

        // right top
        bounds.push(coordinates.webMercator.xyToLatLng([initialExtent.xmax, initialExtent.ymax]))

        return bounds.join(',')
    }

    const info = {
        "name": rootData.name,
        "format": "pbf",
        "version": rootData.currentVersion || 1,
        "bounds": getBounds(rootData.initialExtent),
        "minzoom": levels.min,
        "maxzoom": levels.max,
        "type": "overlay",
        "json": `{"vector_layers":  ${JSON.stringify(toVectorLayers(layers))}}`
    }
    return info
}

/*  this is considered bad practice because a command should never
    return some data

    TODO: re-design the application in order to read the
    layer metadata in a more clever way

*/
/** 
 * @returns: {Set} a set of layers that are collected from the tiles
 * @todo: re-design the application in order to read the
    layer metadata in a more clever way
 * */
const writeBundles = async (tileContainer, level, debug) => {
    let bundleLayers = new Set()
    const allBundles = content.enumerateBundles(level.folder)
    for (const bundlePath of allBundles) {
        log(debug, `processing ${bundlePath}`);
        const bundleOffset = bundle.offset(bundlePath)
        const bundleFileDescriptor = await fsOpen(bundlePath, 'r')
        const tileIndex = await bundle.tileIndex(bundleFileDescriptor)
        for (const index of tileIndex) {
            const tile = await bundle.tiles(bundleFileDescriptor, index)
            // write tile to tile container
            const row = bundleOffset.rowOffset + index.row
            const column = bundleOffset.columnOffset + index.column
            await tileContainer.putTileAsync(level.z, column, row, tile)
            // read layer information from tile 
            const tileLayers = await exploreLayers(tile)
            bundleLayers = new Set([...bundleLayers, ...tileLayers])
        }

        await fsClose(bundleFileDescriptor)
    }
    return bundleLayers
}

/**
 * 
 * @param {MBTiles object} tileContainer a writeable object that represents a Mapbox tiles container (MBTiles)
 * @param {Array[Object]} levels the levels objects that should be transformed
 * @returns {Set[String]} contains the names of all layers that are used by the transformed vector tiles
 */
const doWrite = async (tileContainer, levels, debug) => {
    let layers = new Set()
    for (const level of levels) {
        log(debug, `processing level ${level.z}`)
        const bundleLayers = await writeBundles(tileContainer, level, debug)
        layers = new Set([...layers, ...bundleLayers])
    }
    return layers
}

/**
 * 
 * @param {String} sourceFolder the path to the expanded VTPK folder
 * @param {Object} inspection contains data about the available zoom levels
 */
const doTransform = async (sourceFolder, options, debug) => {
    /*
      Min and Max levels are given by the levels within the VTPK AND the 
      level the user wants to process.
    */
    const minLevel = Math.max(options.processingLevels.min, options.z.min)
    const maxLevel = Math.min(options.processingLevels.max, options.z.max)
    // restrict the zoom levels to the given boundarys
    const levelsToProcess = options.levels.filter(level => (level.z >= minLevel && level.z <= maxLevel))

    const tileRoot = root(sourceFolder)
    const mbtilesName = `${tileRoot.name}.mbtiles`
    let mbtlesFile = mbtilesName;
    if (options.outputDir) {
        mbtlesFile = path.join(options.outputDir, mbtilesName);
    }
    log(debug, `creating MBTiles container ${mbtlesFile}`)
    try {
        const tileContainer = await createMBTileContainer(mbtlesFile)
        await tileContainer.startWritingAsync()
        // BAD PRACTICE, should NOT read and write with a single function
        const layers = await doWrite(tileContainer, levelsToProcess, debug)
        await tileContainer.putInfoAsync(tilesetInfo(tileRoot, { min: minLevel, max: maxLevel } , layers))
        await tileContainer.stopWritingAsync()
        return mbtlesFile;
    }
    catch (error) {
        console.error(error)
    }
}

const transform = async (sourceFolder, options, debug = false) => {
    
        const zlevels = (options && options.levels) ? options.levels : null;

        const processingLevels = levels(zlevels)
        const inspection = await inspect(sourceFolder)

        if (!inspection.compliance.isCompliant) {
            throw {
               message: 'The given VTPK source folder does not meet the requirements',
               compliance: inspection.compliance
            };

        }

        const mergedInspection = {
            ...inspection, ...{ processingLevels: processingLevels }
        }

        const mergedOptions = {
            ...options, ...mergedInspection
        }

        return await doTransform(sourceFolder, mergedOptions, debug)

}

module.exports = transform