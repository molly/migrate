import {join, extname} from 'node:path';
import {URL} from 'node:url';
import {inspect} from 'node:util';
import fs from 'fs-extra';
import {GhostLogger} from '@tryghost/logging';
import {ui} from '@tryghost/pretty-cli';
import xml2json from 'xml2json';
import wpAPISource from '../sources/wp-api.js';

const __dirname = new URL('.', import.meta.url).pathname;

// Internal ID in case we need one.
const id = 'wp-api';

const group = 'Sources:';

// The command to run and any params
const flags = 'wp-api <url>';

// Description for the top level command
const desc = 'Migrate from WordPress using JSON API';

// Descriptions for the individual params
const paramsDesc = ['Path to a WordPress site, without trailing slash'];

// Configure all the options
const setup = (sywac) => {
    sywac.boolean('-V --verbose', {
        defaultValue: false,
        desc: 'Show verbose output'
    });
    sywac.boolean('--zip', {
        defaultValue: true,
        desc: 'Create a zip file (set to false to skip)'
    });
    sywac.array('-s --scrape', {
        choices: ['all', 'img', 'web', 'media', 'files', 'none'],
        defaultValue: 'all',
        desc: 'Configure scraping tasks'
    });
    sywac.number('--sizeLimit', {
        defaultValue: false,
        desc: 'Assets larger than this size (defined in MB) will be ignored'
    });
    sywac.boolean('-I, --info', {
        defaultValue: false,
        desc: 'Show initalisation info only'
    });
    sywac.number('-b, --batch', {
        defaultValue: 0,
        desc: 'Run a batch (defaults to not batching)'
    });
    sywac.number('-l, --limit', {
        defaultValue: 100,
        desc: 'Number of items fetched in a batch i.e. batch size'
    });
    sywac.string('-a, --auth', {
        defaultValue: null,
        desc: 'Provide a user and password to authenticate the WordPress API (<user>:<password>)'
    });
    sywac.string('-u, --users', {
        defaultValue: null,
        desc: 'Provide a JSON file with users'
    });
    sywac.boolean('--fallBackHTMLCard', {
        defaultValue: false,
        desc: 'Fall back to convert to HTMLCard, if standard Mobiledoc convert fails'
    });
    sywac.boolean('--tags', {
        defaultValue: true,
        desc: 'Set to false if you don\'t want to import WordPress tags, only categories'
    });
    sywac.string('--addTag', {
        defaultValue: null,
        desc: 'Provide a tag slug which should be added to every post in this migration'
    });
    sywac.string('--featureImage', {
        defaultValue: 'featuredmedia',
        choices: ['featuredmedia', 'og:image', 'none'],
        desc: 'Change which value is used as the feature image'
    });
    sywac.enumeration('--datedPermalinks', {
        choices: ['none', '/yyyy/mm/', '/yyyy/mm/dd/', '/*/yyyy/mm/', '/*/yyyy/mm/dd/'],
        defaultValue: 'none',
        desc: 'Set the dated permalink structure (e.g. /yyyy/mm/dd/) [See readme for details]'
    });
    sywac.string('--cpt', {
        defaultValue: null,
        desc: 'The slug(s) of custom post type(s), e.g. `resources,newsletters`'
    });
    sywac.string('--excerptSelector', {
        defaultValue: null,
        desc: 'Pass in a valid selector to grab a custom excerpt from the post content, e. g. `h2.excerpt`'
    });
    sywac.string('--removeSelectors', {
        defaultValue: null,
        desc: 'Pass in a string of CSS selectors for elements that will be removed, e.g. \'.ads, script[src*="adnetwork.com"]\''
    });
    sywac.boolean('--trustSelfSignedCert', {
        defaultValue: false,
        desc: 'Trust self-signed certificates (such as for local installs)'
    });
    sywac.boolean('--cache', {
        defaultValue: true,
        desc: 'Persist local cache after migration is complete (Only if `--zip` is `true`)'
    });
};

// What to do when this command is executed
const run = async (argv) => {
    let context = {
        errors: [],
        warnings: []
    };

    const startMigrationTime = Date.now();

    let logger;

    // If testing, mock the logger to keep it quiet
    if (process.env.NODE_ENV === 'test') {
        logger = {
            warn: () => {},
            error: () => {}
        };
    } else {
        logger = new GhostLogger({
            domain: argv.cacheName || 'wp_migration', // This can be unique per migration
            mode: 'long',
            transports: (argv.verbose) ? ['stdout', 'file'] : ['file'],
            path: join(__dirname, '../../../', '/logs')
        });
    }

    // Remove trailing slash from URL
    if (argv.url.endsWith('/')) {
        argv.url = argv.url.slice(0, -1);
    }

    if (argv.auth) {
        let auth = argv.auth.split(':');

        if (auth.length < 2 || auth.length >= 3) {
            ui.log.info('Not running in authenticated mode. Please provide the credentials in this format: <user>:<password>');
            context.apiUser = {};
        } else {
            ui.log.info('Using authentication for WordPress API');
            context.apiUser = {username: auth[0], password: auth[1]};
        }
    }

    if (argv.users) {
        const usersFileExt = extname(argv.users).replace('.', '').toLowerCase();

        if (usersFileExt === 'json') {
            context.usersJSON = await fs.readJSON(argv.users);
        } else if (usersFileExt === 'xml') {
            const xmlData = fs.readFileSync(argv.users, 'utf8');
            const userXMLJSON = xml2json.toJson(xmlData, {
                object: true
            });

            let usersObjects = [];

            userXMLJSON.root.row.forEach((user) => {
                usersObjects.push({
                    id: (user.source_user_id.length) ? parseInt(user.source_user_id) : null,
                    slug: (user.user_nicename.length) ? user.user_nicename : null,
                    name: (user.display_name.length) ? user.display_name : null,
                    description: (user.description.length) ? user.description : null,
                    email: (user.user_email.length) ? user.user_email : null,
                    url: (user.user_url.length) ? user.user_url : null
                });
            });

            context.usersJSON = usersObjects;
        } else {
            ui.log.warn(`${argv.users} is an unsupported file format. Should be JSON or XML`);
        }
    }

    if (argv.verbose) {
        ui.log.info(`${argv.info ? 'Fetching info' : 'Migrating'} from site at ${argv.url}`);
    }

    if (argv.batch !== 0) {
        ui.log.info(`Running batch ${argv.batch} (groups of ${argv.limit} posts)`);
    }

    try {
        // Fetch the tasks, configured correctly according to the options passed in
        let migrate = wpAPISource.getTaskRunner(argv.url, argv, logger);

        // Run the migration
        await migrate.run(context);

        if (argv.info && context.info) {
            let batches = context.info.batches.posts + context.info.batches.pages;
            ui.log.info(`Batch info: ${context.info.totals.posts} posts, ${context.info.totals.pages} pages, ${batches} batches.`);
        }

        logger.info({
            message: 'Migration finished',
            duration: Date.now() - startMigrationTime
        });

        if (argv.verbose) {
            ui.log.info('Done', inspect(context.result.data, false, 2));
        }
    } catch (error) {
        logger.info({
            message: 'Migration finished but with errors',
            error,
            duration: Date.now() - startMigrationTime
        });
    }

    if (context.warnings.length > 0) {
        ui.log.warn(context.warnings);
    }
};

export default {
    id,
    group,
    flags,
    desc,
    paramsDesc,
    setup,
    run
};
