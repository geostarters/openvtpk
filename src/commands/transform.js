'use strict'

const { Command } = require('@oclif/command')
const transform = require('../shared/transform')
const params = require('../shared/params')

class TransformCommand extends Command {
    async run() {
        const { args, flags } = this.parse(TransformCommand)
        this.log(`transforming VTPK ${args.sourceFolder} into MBTiles container`)

        try {
            await transform(args.sourceFolder, {levels: flags.levels}, true)
        } catch (error) {
            this.error(error.message)
            console.dir(error.compliance)
            this.exit(1)
        }
        
    }

}

TransformCommand.description = `Takes an expanded VTPK container and transforms it into an MBTiles container
`
TransformCommand.args = [
    params.args.sourceFolder
]

TransformCommand.flags = {
    levels: params.flags.levels
}

module.exports = TransformCommand