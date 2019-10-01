'use strict'

const fp = require('fastify-plugin')
const readFile = require('fs').readFile
const resolve = require('path').resolve
const join = require('path').join
const HLRU = require('hashlru')
const supportedEngines = ['ejs', 'nunjucks', 'pug', 'handlebars', 'marko', 'ejs-mate', 'mustache', 'art-template']

function fastifyView (fastify, opts, next) {
  if (!opts.engine) {
    next(new Error('Missing engine'))
    return
  }

  const type = Object.keys(opts.engine)[0]
  if (supportedEngines.indexOf(type) === -1) {
    next(new Error(`'${type}' not yet supported, PR? :)`))
    return
  }

  const charset = opts.charset || 'utf-8'
  const engine = opts.engine[type]
  const options = opts.options || {}
  const templatesDir = resolve(opts.templates || './')
  const lru = HLRU(opts.maxCache || 100)
  const includeViewExtension = opts.includeViewExtension || false
  const prod = typeof opts.production === 'boolean' ? opts.production : process.env.NODE_ENV === 'production'
  const defaultCtx = opts.defaultContext || {}
  const renders = {
    marko: viewMarko,
    'ejs-mate': viewEjsMate,
    handlebars: viewHandlebars,
    mustache: viewMustache,
    nunjucks: viewNunjucks,
    'art-template': viewArtTemplate,
    _default: view
  }

  const renderer = renders[type] ? renders[type] : renders._default

  fastify.decorate('view', function () {
    const args = Array.from(arguments)

    let done
    if (typeof args[args.length - 1] === 'function') {
      done = args.pop()
    }

    const promise = new Promise((resolve, reject) => {
      renderer.apply({
        getHeader: () => {},
        header: () => {},
        send: result => {
          if (result instanceof Error) {
            reject(result)
            return
          }

          resolve(result)
        }
      }, args)
    })

    if (done && typeof done === 'function') {
      promise.then(done.bind(null, null), done)
      return
    }

    return promise
  })

  fastify.decorateReply('view', function () {
    renderer.apply(this, arguments)
  })

  function getPage (page, extension) {
    if (includeViewExtension) {
      return `${page}.${extension}`
    }
    return page
  }

  // Gets template as string from LRU cache or filesystem.
  const getTemplateString = function (file, callback) {
    const data = lru.get(file)
    if (data && prod) {
      callback(null, data)
    } else {
      readFile(join(templatesDir, file), 'utf-8', (err, data) => {
        if (err) {
          callback(err, null)
          return
        }
        if (options.useHtmlMinifier && (typeof options.useHtmlMinifier.minify === 'function')) {
          data = options.useHtmlMinifier.minify(data, options.htmlMinifierOptions || {})
        }
        lru.set(file, data)
        callback(null, data)
      })
    }
  }

  // Gets partials as collection of strings from LRU cache or filesystem.
  const getPartials = function (page, partials, callback) {
    const partialsObj = lru.get(`${page}-Partials`)

    if (partialsObj && prod) {
      callback(null, partialsObj)
    } else {
      let filesToLoad = Object.keys(partials).length

      if (filesToLoad === 0) {
        callback(null, {})
        return
      }

      let error = null
      const partialsHtml = {}
      Object.keys(partials).map((key, index) => {
        readFile(join(templatesDir, partials[key]), 'utf-8', (err, data) => {
          if (err) {
            error = err
          }
          if (options.useHtmlMinifier && (typeof options.useHtmlMinifier.minify === 'function')) {
            data = options.useHtmlMinifier.minify(data, options.htmlMinifierOptions || {})
          }

          partialsHtml[key] = data
          if (--filesToLoad === 0) {
            lru.set(`${page}-Partials`, partialsHtml)
            callback(error, partialsHtml)
          }
        })
      })
    }
  }

  function readCallback (that, page, data) {
    return function _readCallback (err, html) {
      if (err) {
        that.send(err)
        return
      }

      let compiledPage
      try {
        options.filename = join(templatesDir, page)
        compiledPage = engine.compile(html, options)
      } catch (error) {
        that.send(error)
        return
      }
      lru.set(page, compiledPage)

      if (!that.getHeader('content-type')) {
        that.header('Content-Type', 'text/html; charset=' + charset)
      }
      let cachedPage
      try {
        cachedPage = lru.get(page)(data)
      } catch (error) {
        cachedPage = error
      }
      if (options.useHtmlMinifier && (typeof options.useHtmlMinifier.minify === 'function')) {
        cachedPage = options.useHtmlMinifier.minify(cachedPage, options.htmlMinifierOptions || {})
      }

      const mycallback = function (that, page, data) {
        return function _mycallback (err, html) {
          if (err) {
            that.send(err)
            return
          }
          options.filename = join(templatesDir, 'layout.ejs')
          const compiledLayoutPage = engine.compile(html, options)
          const layoutData = Object.assign({}, data, parseContents({ body: cachedPage }))
          compiledLayoutPage(layoutData)

          that.send(compiledLayoutPage(layoutData))
        }
      }

      if (data.hasLayout) {
        readFile(join(templatesDir, 'layout.ejs'), 'utf8', mycallback(that, page, data))
      } else {
        that.send(cachedPage)
      }
    }
  }

  function view (page, data) {
    if (!page) {
      this.send(new Error('Missing page'))
      return
    }

    data = Object.assign({}, defaultCtx, data)
    data.pageName = page
    data.contentFor = contentFor
    // append view extension
    page = getPage(page, type)

    const toHtml = lru.get(page)

    if (toHtml && prod) {
      if (!this.getHeader('content-type')) {
        this.header('Content-Type', 'text/html; charset=' + charset)
      }
      this.send(toHtml(data))
      return
    }

    readFile(join(templatesDir, page), 'utf8', readCallback(this, page, data))
  }

  function viewEjsMate (page, data) {
    if (!page || !data) {
      this.send(new Error('Missing data'))
      return
    }
    data = Object.assign({}, defaultCtx, data)
    const confs = Object.assign({}, options)
    if (!confs.settings) {
      confs.settings = {}
    }
    // ejs-mate use views to find layouts
    confs.settings.views = templatesDir
    // setting locals to pass data by
    confs.locals = Object.assign({}, confs.locals, data)
    // append view extension
    page = getPage(page, 'ejs')
    engine(join(templatesDir, page), confs, (err, html) => {
      if (err) return this.send(err)
      if (options.useHtmlMinifier && (typeof options.useHtmlMinifier.minify === 'function')) {
        html = options.useHtmlMinifier.minify(html, options.htmlMinifierOptions || {})
      }
      this.header('Content-Type', 'text/html; charset=' + charset).send(html)
    })
  }

  function viewArtTemplate (page, data) {
    if (!page || !data) {
      this.send(new Error('Missing data'))
      return
    }
    data = Object.assign({}, defaultCtx, data)
    // Append view extension.
    page = getPage(page, 'art')

    const defaultSetting = {
      debug: process.env.NODE_ENV !== 'production',
      root: templatesDir
    }

    // merge engine options
    const confs = Object.assign({}, defaultSetting, options)

    function render (filename, data) {
      confs.filename = join(templatesDir, filename)
      const render = engine.compile(confs)
      return render(data)
    }

    try {
      const html = render(page, data)
      if (!this.getHeader('content-type')) {
        this.header('Content-Type', 'text/html; charset=' + charset)
      }
      this.send(html)
    } catch (error) {
      this.send(error)
    }
  }

  function viewNunjucks (page, data) {
    if (!page || !data) {
      this.send(new Error('Missing data'))
      return
    }
    const env = engine.configure(templatesDir, options)
    if (typeof options.onConfigure === 'function') {
      options.onConfigure(env)
    }
    data = Object.assign({}, defaultCtx, data)
    // Append view extension.
    page = getPage(page, 'njk')
    env.render(join(templatesDir, page), data, (err, html) => {
      if (err) return this.send(err)
      if (options.useHtmlMinifier && (typeof options.useHtmlMinifier.minify === 'function')) {
        html = options.useHtmlMinifier.minify(html, options.htmlMinifierOptions || {})
      }
      this.header('Content-Type', 'text/html; charset=' + charset).send(html)
    })
  }

  function viewMarko (page, data, opts) {
    if (!page || !data) {
      this.send(new Error('Missing data'))
      return
    }

    data = Object.assign({}, defaultCtx, data)
    // append view extension
    page = getPage(page, type)

    const template = engine.load(join(templatesDir, page))

    if (opts && opts.stream) {
      if (typeof options.useHtmlMinifyStream === 'function') {
        this.send(template.stream(data).pipe(options.useHtmlMinifyStream(options.htmlMinifierOptions || {})))
      } else {
        this.send(template.stream(data))
      }
    } else {
      template.renderToString(data, send(this))
    }

    function send (that) {
      return function _send (err, html) {
        if (err) return that.send(err)
        if (options.useHtmlMinifier && (typeof options.useHtmlMinifier.minify === 'function')) {
          html = options.useHtmlMinifier.minify(html, options.htmlMinifierOptions || {})
        }
        that.header('Content-Type', 'text/html; charset=' + charset).send(html)
      }
    }
  }

  function viewHandlebars (page, data) {
    if (!page || !data) {
      this.send(new Error('Missing data'))
      return
    }

    const options = Object.assign({}, opts.options)
    data = Object.assign({}, defaultCtx, data)
    // append view extension
    page = getPage(page, 'hbs')
    getTemplateString(page, (err, templateString) => {
      if (err) {
        this.send(err)
        return
      }

      getPartials(page, options.partials || {}, (err, partialsObject) => {
        if (err) {
          this.send(err)
          return
        }

        Object.keys(partialsObject).forEach((name) => {
          engine.registerPartial(name, engine.compile(partialsObject[name]))
        })

        const template = engine.compile(templateString)
        const html = template(data)

        if (!this.getHeader('content-type')) {
          this.header('Content-Type', 'text/html; charset=' + charset)
        }
        this.send(html)
      })
    })
  }

  function viewMustache (page, data, opts) {
    if (!page || !data) {
      this.send(new Error('Missing data'))
      return
    }

    const options = Object.assign({}, opts)
    data = Object.assign({}, defaultCtx, data)
    // append view extension
    page = getPage(page, 'mustache')
    getTemplateString(page, (err, templateString) => {
      if (err) {
        this.send(err)
        return
      }
      getPartials(page, options.partials || {}, (err, partialsObject) => {
        if (err) {
          this.send(err)
          return
        }
        const html = engine.render(templateString, data, partialsObject)

        if (!this.getHeader('content-type')) {
          this.header('Content-Type', 'text/html; charset=' + charset)
        }
        this.send(html)
      })
    })
  }

  const contentPattern = '&&<>&&'

  function contentFor(contentName) {
    return contentPattern + contentName + contentPattern;
  }
  
  function parseContents (locals) {
    let name; let i = 1; const str = locals.body
    const regex = new RegExp('\n?' + contentPattern + '.+?' + contentPattern + '\n?', 'g')
    const split = str.split(regex)
    const matches = str.match(regex)

    locals.body = split[0]

    if (matches !== null) {
      matches.forEach(function (match) {
        name = match.split(contentPattern)[1]
        locals[name] = split[i]
        i++
      })
    }

    return locals
  }

  // function parseScripts (locals) {
  //   const str = locals.body; const regex = /\<script[\s\S]*?\>[\s\S]*?\<\/script\>/g

  //   if (regex.test(str)) {
  //     locals.body = str.replace(regex, '')
  //     locals.script = str.match(regex).join('\n')
  //   }
  // }

  // function parseStyles (locals) {
  //   const str = locals.body; const regex = /(?:\<style[\s\S]*?\>[\s\S]*?\<\/style\>)|(?:\<link[\s\S]*?\>(?:\<\/link\>)?)/g

  //   if (regex.test(str)) {
  //     locals.body = str.replace(regex, '')
  //     locals.style = str.match(regex).join('\n')
  //   }
  // }

  // function parseMetas (locals) {
  //   const str = locals.body; const regex = /\<meta[\s\S]*?\>/g

  //   if (regex.test(str)) {
  //     locals.body = str.replace(regex, '')
  //     locals.meta = str.match(regex).join('\n')
  //   }
  // }

  next()
}

module.exports = fp(fastifyView, { fastify: '^2.x' })
