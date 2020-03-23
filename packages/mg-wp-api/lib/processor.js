const fs = require('fs-extra');
const _ = require('lodash');
const $ = require('cheerio');
const url = require('url');

module.exports.processAuthor = (wpAuthor) => {
    return {
        url: wpAuthor.link,
        data: {
            id: wpAuthor.id && wpAuthor.id,
            slug: wpAuthor.slug,
            name: wpAuthor.name,
            bio: wpAuthor.description,
            profile_image: wpAuthor.avatar_urls && wpAuthor.avatar_urls['96'],
            email: wpAuthor.email && wpAuthor.email
        }
    };
};

module.exports.processTerm = (wpTerm) => {
    return {
        url: wpTerm.link,
        data: {
            slug: wpTerm.slug,
            name: wpTerm.name
        }
    };
};

module.exports.processTerms = (wpTerms) => {
    let categories = [];
    let tags = [];

    wpTerms.forEach((taxonomy) => {
        taxonomy.forEach((term) => {
            if (term.taxonomy === 'category') {
                categories.push(this.processTerm(term));
            }

            if (term.taxonomy === 'post_tag') {
                tags.push(this.processTerm(term));
            }
        });
    });

    return categories.concat(tags);
};

module.exports.processContent = (html) => {
    // Drafts can have empty post bodies
    if (!html) {
        return '';
    }

    const $html = $.load(html, {
        decodeEntities: false
    });

    // Handle twitter embeds
    $html('p > script[src="https://platform.twitter.com/widgets.js"]').remove();

    $html('#toc_container').each((i, toc) => {
        $(toc).remove();
    });

    $html('blockquote.twitter-tweet').each((i, el) => {
        let $figure = $('<figure class="kg-card kg-embed-card"></figure>');
        let $script = $('<script async src="https://platform.twitter.com/widgets.js" charset="utf-8"></script>');

        $(el).wrap($figure);
        $figure.append($script);
        $figure.before('<!--kg-card-begin: embed-->');
        $figure.after('<!--kg-card-end: embed-->');
    });

    $html('blockquote.twitter-video').each((i, el) => {
        let $figure = $('<figure class="kg-card kg-embed-card"></figure>');
        let $script = $('<script async src="https://platform.twitter.com/widgets.js" charset="utf-8"></script>');

        $(el).wrap($figure);
        $figure.append($script);
        $figure.before('<!--kg-card-begin: embed-->');
        $figure.after('<!--kg-card-end: embed-->');
    });

    // Handle instagram embeds
    $html('script[src="//platform.instagram.com/en_US/embeds.js"]').remove();
    $html('#fb-root').each((i, el) => {
        if ($(el).prev().get(0) && $(el).prev().get(0).name === 'script') {
            $(el).prev().remove();
        }
        if ($(el).next().get(0) && $(el).next().get(0).name === 'script') {
            $(el).next().remove();
        }

        $(el).remove();
    });

    $html('blockquote.instagram-media').each((i, el) => {
        let src = $(el).find('a').attr('href');
        let parsed = url.parse(src);

        if (parsed.search) {
            // remove possible query params
            parsed.search = null;
        }
        src = url.format(parsed, {search: false});

        let $iframe = $('<iframe class="instagram-media instagram-media-rendered" id="instagram-embed-0" allowtransparency="true" allowfullscreen="true" frameborder="0" height="968" data-instgrm-payload-id="instagram-media-payload-0" scrolling="no" style="background: white; max-width: 658px; width: calc(100% - 2px); border-radius: 3px; border: 1px solid rgb(219, 219, 219); box-shadow: none; display: block; margin: 0px 0px 12px; min-width: 326px; padding: 0px;"></iframe>');
        let $script = $('<script async="" src="//www.instagram.com/embed.js"></script>');
        let $figure = $('<figure class="instagram"></figure>');

        $iframe.attr('src', `${src}embed/captioned/`);
        $figure.append($iframe);
        $figure.append($script);

        $(el).replaceWith($figure);
    });

    $html('iframe').each((i, iframe) => {
        if ($(iframe).parents('figure').length < 1) {
            // ensure we wrap all iframe in an html card, that haven't been wrapped in an embed card (figure) yet
            $(iframe).before('<!--kg-card-begin: html-->');
            $(iframe).after('<!--kg-card-end: html-->');
        }
    });

    // Wrap custom styled divs in HTML card
    $html('div[style]').each((i, div) => {
        $(div).before('<!--kg-card-begin: html-->');
        $(div).after('<!--kg-card-end: html-->');
    });

    $html('h1[id], h2[id], h3[id], h4[id], h5[id], h6[id]').each((i, heading) => {
        $(heading).before('<!--kg-card-begin: html-->');
        $(heading).after('<!--kg-card-end: html-->');
    });

    // (Some) WordPress renders gifs a different way. They use an `img` tag with a `src` for a still image,
    // and a `data-gif` attribute to reference the actual gif. We need `src` to be the actual gif.
    $html('img[data-gif]').each((i, gif) => {
        let gifSrc = $(gif).attr('data-gif');
        $(gif).attr('src', gifSrc);
    });

    // convert HTML back to a string
    html = $html.html();

    return html;
};

/**
 * Convert data to the intermediate format of
 * {
 *   posts: [
 *      {
 *          url: 'http://something',
 *          data: {
 *             title: 'blah',
*              ...
 *          }
 *      }
 *   ]
 * }
 */
module.exports.processPost = (wpPost, users) => {
    // @note: we don't copy excerpts because WP generated excerpts aren't better than Ghost ones but are often too long.
    const post = {
        url: wpPost.link,
        data: {
            slug: wpPost.slug,
            title: wpPost.title.rendered,
            comment_id: wpPost.id,
            html: wpPost.content.rendered,
            type: wpPost.type === 'post' ? 'post' : 'page',
            status: wpPost.status === 'publish' ? 'published' : 'draft',
            published_at: wpPost.date_gmt,
            author: users ? users.find((user) => {
                // Try to use the user data returned from the API
                return user.data.id === wpPost.author;
            }) : null
        }
    };

    if (wpPost._embedded['wp:featuredmedia']) {
        const wpImage = wpPost._embedded['wp:featuredmedia'][0];
        post.data.feature_image = wpImage.source_url;
    }

    if (wpPost._embedded.author && !post.data.author) {
        // use the data passed along the post if we couldn't match the user from the API
        const wpAuthor = wpPost._embedded.author[0];
        post.data.author = this.processAuthor(wpAuthor);
    }

    if (wpPost._embedded['wp:term']) {
        const wpTerms = wpPost._embedded['wp:term'];
        post.data.tags = this.processTerms(wpTerms);

        post.data.tags.push({
            url: 'migrator-added-tag', data: {name: '#wordpress'}
        });
    }

    // Some HTML content needs to be modified so that our parser plugins can interpret it
    post.data.html = this.processContent(post.data.html);

    return post;
};

module.exports.processPosts = (posts, users) => {
    return posts.map(post => this.processPost(post, users));
};

module.exports.processAuthors = (authors) => {
    return authors.map(author => this.processAuthor(author));
};

module.exports.all = async ({result: input, usersJSON}) => {
    if (usersJSON) {
        const mergedUsers = [];
        try {
            let passedUsers = await fs.readJSON(usersJSON);
            console.log(`Passed a users file with ${passedUsers.length} entries, processing now!`);
            await passedUsers.map((passedUser) => {
                const matchedUser = _.find(input.users, (fetchedUser) => {
                    if (fetchedUser.id && passedUser.id && fetchedUser.id === passedUser.id) {
                        return fetchedUser;
                    } else if (fetchedUser.slug && passedUser.slug && fetchedUser.slug === passedUser.slug) {
                        return fetchedUser;
                    } else if (fetchedUser.name && passedUser.name && fetchedUser.name === passedUser.name) {
                        return fetchedUser;
                    } else {
                        return false;
                    }
                });
                mergedUsers.push(Object.assign({}, passedUser, matchedUser));
            });
        } catch (error) {
            throw new Error('Unable to process passed users file');
        }
        input.users = mergedUsers;
    }

    const output = {
        users: this.processAuthors(input.users)
    };

    output.posts = this.processPosts(input.posts, output.users);

    return output;
};
