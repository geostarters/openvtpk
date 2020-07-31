'use strict'

const transform = require('./shared/transform');
const inspect = require('./shared/inspect');

class Openvtpk {

    static async inspect(sourceFolder){

        return await inspect(sourceFolder)

    }

    static async transform(sourceFolder, options){

        return await transform(sourceFolder, options)

    }

}

module.exports = Openvtpk;
//module.exports = require('@oclif/command')
