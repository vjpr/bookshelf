var When      = require('when');
var equal     = require('assert').equal;
var deepEqual = require('assert').deepEqual;

// Data
module.exports = function(Bookshelf, handler) {

  var Models      = require('../shared/objects')(Bookshelf).Models;
  var Collections = require('../shared/objects')(Bookshelf).Collections;

  // Models
  var Site     = Models.Site;
  var SiteMeta = Models.SiteMeta;
  var Admin    = Models.Admin;
  var Author   = Models.Author;
  var Blog     = Models.Blog;
  var Post     = Models.Post;
  var Comment  = Models.Comment;
  var Tag      = Models.Tag;
  var Photo    = Models.Photo;

  // Collections
  var Sites    = Collections.Sites;
  var Admins   = Collections.Admins;
  var Blogs    = Collections.Blogs;
  var Posts    = Collections.Posts;
  var Comments = Collections.Comment;
  var Photos   = Collections.Photos;

  describe('Bookshelf Relations', function() {

    describe('Standard Relations - Models', function() {

      it('handles belongsTo', function(ok) {

        var responses = [];

        new Blog({id: 4})
          .fetch()
          .then(function(model) {
            responses.push({blog: model.toJSON()});
            return model.site().fetch();
          })
          .then(function(site) {
            responses.push({site: site.toJSON()});
            return responses;
          })
          .then(handler(this, ok), ok);
      });

      it('handles hasMany', function(ok) {
        new Blog({id: 1})
          .fetch()
          .then(function(model) {
            return model.posts().fetch();
          })
          .then(handler(this, ok), ok);
      });

      it('handles hasOne', function(ok) {
        new Site({id: 1})
          .meta()
          .fetch()
          .then(handler(this, ok), ok);
      });

      it('handles belongsToMany', function(ok) {
        new Author({id: 1})
          .posts()
          .fetch()
          .then(handler(this, ok), ok);
      });

    });

    describe('Eager Loading - Models', function() {

      it('eager loads "hasOne" relationships correctly', function(ok) {
        new Site({id: 1}).fetch({
          withRelated: ['meta']
        }).then(handler(this, ok), ok);
      });

      it('eager loads "hasMany" relationships correctly', function(ok) {
        new Site({id: 1}).fetch({
          withRelated: ['authors', 'blogs']
        }).then(handler(this, ok), ok);
      });

      it('eager loads "belongsTo" relationships correctly', function(ok) {
        new Blog({id: 3}).fetch({
          withRelated: ['site']
        }).then(handler(this, ok), ok);
      });

      it('Throws an error if you try to fetch a related object without the necessary key', function(ok) {
        new Blog({id: 1}).site().fetch().then(null, function() {
          ok();
        });
      });

      it('eager loads "belongsToMany" models correctly', function(ok) {
        new Post({id: 1}).fetch({
          withRelated: ['tags']
        }).then(handler(this, ok), ok);
      });

    });

    describe('Eager Loading - Collections', function() {

      it('eager loads "hasOne" models correctly', function(ok) {
        new Sites().fetch({
          withRelated: ['admins']
        }).then(handler(this, ok), ok);
      });

      it('eager loads "belongsTo" models correctly', function(ok) {
        new Blogs().fetch({
          withRelated: ['site']
        }).then(handler(this, ok), ok);
      });

      it('eager loads "hasMany" models correctly', function(ok) {
        new Site({id: 1}).fetch({
          withRelated: ['blogs']
        }).then(handler(this, ok), ok);
      });

      it('eager loads "belongsToMany" models correctly', function(ok) {
        new Posts()
          .query('where', 'blog_id', '=', 1)
          .fetch({
            withRelated: ['tags']
          })
          .then(handler(this, ok), ok);
      });

    });

    describe('Nested Eager Loading - Models', function() {

      it('eager loads "hasMany" -> "hasMany"', function(ok) {
        new Site({id: 1}).fetch({
          withRelated: ['authors.ownPosts']
        }).then(handler(this, ok), ok);
      });

      it('eager loads "hasMany" -> "belongsToMany"', function(ok) {
        new Site({id: 1}).fetch({
          withRelated: ['authors.posts']
        }).then(handler(this, ok), ok);
      });

      it('does multi deep eager loads', function(ok) {
        new Site({id: 1}).fetch({
          withRelated: ['authors.ownPosts', 'authors.site', 'blogs.posts']
        }).then(handler(this, ok), ok);
      });

    });

    describe('Nested Eager Loading - Collections', function() {

      it('eager loads "hasMany" -> "hasMany"', function(ok) {
        var site = new Sites();
        site.fetch({
          withRelated: ['authors.ownPosts']
        }).then(handler(this, ok), ok);
      });

    });

    describe('Model & Collection - load', function() {

      it('eager loads relations on a populated model', function(ok) {
        new Site({id: 1}).fetch().then(function(m) {
          return m.load(['blogs', 'authors.site']);
        }).then(handler(this, ok), ok);
      });

      it('eager loads attributes on a collection', function(ok) {
        new Sites().fetch().then(function(c) {
          return c.load(['blogs', 'authors.site']);
        }).then(handler(this, ok), ok);
      });
    });

    describe('Pivot Tables', function() {

      it('provides "attach" for creating or attaching records', function(ok) {

        var admin1 = new Admin({username: 'syncable', password: 'test'});
        var admin2 = new Admin({username: 'syncable', password: 'test'});

        When.all([admin1.save(), admin2.save()])
          .then(function() {
            return When.all([
              new Site({id: 1}).admins().attach([admin1, admin2]),
              new Site({id: 2}).admins().attach(admin2)
            ]);
          })
          .then(function(resp) {
            return When.all([
              new Site({id: 1}).admins().fetch().then(function(c) {
                c.each(function(m) {
                  equal(m.hasChanged(), false);
                });
                equal(c.at(0).has('pivot_item'), true);
                equal(c.length, 2);
              }),
              new Site({id: 2}).admins().fetch().then(function(c) {
                equal(c.length, 1);
              })
            ]);
          })
          .then(function(resp) {
            return When.all([
              new Site({id: 1}).admins().detach().then(function(c) {
                equal(c.length, 0);
              }),
              new Site({id: 2}).admins().detach().then(function(c) {
                equal(c.length, 0);
              })
            ]).then(function() {
              ok();
            });
          })
          .then(null, function(e) {
            console.log(e.stack);
          });
      });

    });

  });

  describe('Polymorphic associations', function() {

    it('handles morphOne', function(ok) {
      new Author({id: 1})
        .photo()
        .fetch()
        .then(handler(this, ok), ok);
    });

    it('handles morphMany', function(ok) {
      new Site({id: 1})
        .photos()
        .fetch()
        .then(handler(this, ok), ok);
    });

    it('handles morphTo', function(ok) {
      new Photo({id: 1})
        .imageable()
        .fetch()
        .then(handler(this, ok), ok);
    });

    it('eager loads morphMany', function(ok) {
      new Sites().fetch({withRelated: ['photos']}).then(handler(this, ok), ok);
    });

    it('eager loads morphTo', function(ok) {
      new Photos().fetch({withRelated: ['imageable']}).then(handler(this, ok), ok);
    });


  });

};