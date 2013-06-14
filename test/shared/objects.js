
// All Models & Collections Used in the Tests
// (sort of mimics a simple multi-site blogging engine)
module.exports = function(Shelf) {

  var SiteMeta = Shelf.Model.extend({
    tableName: 'sitesmeta',
    site: function() {
      return this.belongsTo(Site);
    }
  });

  var Site = Shelf.Model.extend({
    tableName: 'sites',
    defaults: {
      name: 'Your Cool Site'
    },
    photos: function() {
      return this.morphMany(Photo, 'imageable');
    },
    authors: function() {
      return this.hasMany(Author);
    },
    blogs: function() {
      return this.hasMany(Blog);
    },
    meta: function() {
      return this.hasOne(SiteMeta);
    },
    admins: function() {
      return this.belongsToMany(Admin).withPivot('item');
    }
  });

  var Sites = Shelf.Collection.extend({
    model: Site
  });

  var Admin = Shelf.Model.extend({
    tableName: 'admins',
    hasTimestamps: true
  });

  // All admins for a site.
  var Admins = Shelf.Collection.extend({
    model: Admin
  });

  // Author of a blog post.
  var Author = Shelf.Model.extend({
    tableName: 'authors',
    photo: function() {
      return this.morphOne(Photo, 'imageable');
    },
    site: function() {
      return this.belongsTo(Site);
    },
    posts: function() {
      return this.belongsToMany(Post);
    },
    ownPosts: function() {
      return this.hasMany(Post, 'owner_id');
    }
  });

  // A blog for a site.
  var Blog = Shelf.Model.extend({
    tableName: 'blogs',
    defaults: {
      title: ''
    },
    site: function() {
      return this.belongsTo(Site);
    },
    posts: function() {
      return this.hasMany(Post);
    },
    validate: function(attrs) {
      if (!attrs.title) return 'A title is required.';
    }
  });

  var Blogs = Shelf.Collection.extend({
    model: Blog
  });

  // An individual post on a blog.
  var Post = Shelf.Model.extend({
    tableName: 'posts',
    defaults: {
      author: '',
      title: '',
      body: '',
      published: false
    },
    hasTimestamps: true,
    blog: function() {
      return this.belongsTo(Blog);
    },
    authors: function() {
      return this.belongsToMany(Author);
    },
    tags: function() {
      return this.belongsToMany(Tag);
    },
    comments: function() {
      return this.hasMany(Comment);
    }
  });

  var Posts = Shelf.Collection.extend({
    model: Post
  });

  var Comment = Shelf.Model.extend({
    tableName: 'comments',
    defaults: {
      email: '',
      post: ''
    },
    posts: function() {
      return this.belongsTo(Post);
    }
  });

  var Comments = Shelf.Collection.extend({
    model: Comment
  });

  var Tag = Shelf.Model.extend({
    tableName: 'tags',
    posts: function() {
      return this.belongsToMany(Post);
    }
  });

  var Photo = Shelf.Model.extend({
    tableName: 'photos',
    polymorphic: true,
    imageable: function() {
      return this.morphTo('imageable', Site, Author);
    }
  });

  var Photos = Shelf.Collection.extend({
    model: Photo
  });

  return {
    Models: {
      Site: Site,
      SiteMeta: SiteMeta,
      Admin: Admin,
      Author: Author,
      Blog: Blog,
      Post: Post,
      Comment: Comment,
      Tag: Tag,
      Photo: Photo
    },
    Collections: {
      Sites: Sites,
      Admins: Admins,
      Posts: Posts,
      Blogs: Blogs,
      Comments: Comments,
      Photos: Photos
    }
  };

};